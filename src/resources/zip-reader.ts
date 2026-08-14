/**
 * Opens a zip with its central directory held in memory.
 *
 * yauzl reads each central-directory record with its own small read, so a
 * 26,000-entry client jar costs ~26,000 syscalls and well over a second before
 * the first icon renders. The directory is one contiguous region, so reading it
 * whole and serving those reads from the buffer makes indexing ~6× faster while
 * keeping entry data itself on disk — only the directory stays resident.
 *
 * Anything unexpected (zip64, a truncated archive, no end-of-directory record)
 * falls back to yauzl's own open, which is correct for every archive.
 */

import {
	close as closeFd,
	createReadStream,
	fstat,
	open as openFd,
	read as readFd,
} from 'node:fs';
import { Readable } from 'node:stream';

import { RandomAccessReader, fromRandomAccessReader, open } from 'yauzl';

import type { ZipFile } from 'yauzl';

const EOCD_SIGNATURE = 0x06_05_4B_50;
/** End-of-directory record plus the largest possible archive comment. */
const EOCD_SEARCH_BYTES = 22 + 0xFF_FF;
const ZIP64_SENTINEL = 0xFF_FF_FF_FF;
/** Above this, a range streams from its own descriptor instead of one buffer. */
const MAX_BUFFERED_READ_BYTES = 32 * 1024 * 1024;

interface CentralDirectory {
	offset: number;
	size: number;
}

/** Locate the central directory from the end-of-directory record. */
function findCentralDirectory(tail: Buffer, tailStart: number): CentralDirectory | null {
	for (let index = tail.length - 22; index >= 0; index--) {
		if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) {
			continue;
		}
		const size = tail.readUInt32LE(index + 12);
		const offset = tail.readUInt32LE(index + 16);
		// Zip64 archives keep the real values elsewhere; let yauzl handle those.
		if (size === ZIP64_SENTINEL || offset === ZIP64_SENTINEL) {
			return null;
		}
		if (offset + size > tailStart + index) {
			return null;
		}
		return { offset, size };
	}
	return null;
}

/** Promisified positional read; a raw descriptor avoids FileHandle's close-on-GC. */
async function readAt(fd: number, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
	return new Promise((resolve, reject) => {
		readFd(fd, buffer, offset, length, position, (err, bytesRead) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(bytesRead);
		});
	});
}

class BufferedDirectoryReader extends RandomAccessReader {
	private readonly path: string;
	private readonly fd: number;
	private readonly directory: Buffer;
	private readonly directoryStart: number;

	constructor(path: string, fd: number, directory: Buffer, directoryStart: number) {
		super();
		this.path = path;
		this.fd = fd;
		this.directory = directory;
		this.directoryStart = directoryStart;
	}

	// eslint-disable-next-line unicorn/prefer-private-class-fields -- yauzl calls this hook by name
	_readStreamForRange(start: number, end: number): Readable {
		const directoryEnd = this.directoryStart + this.directory.length;
		if (start >= this.directoryStart && end <= directoryEnd) {
			return Readable.from([this.directory.subarray(start - this.directoryStart, end - this.directoryStart)]);
		}
		const length = end - start;
		if (length > MAX_BUFFERED_READ_BYTES) {
			// Its own descriptor: an entry this large should stream, not be buffered.
			return createReadStream(this.path, { start, end: end - 1 });
		}
		// One positional read per range, handed back as a stream. Piping the shared
		// descriptor directly is not an option: yauzl destroys these streams, and
		// a destroyed stream closes the descriptor underneath it.
		const { fd } = this;
		return Readable.from((async function *read() {
			const buffer = Buffer.alloc(length);
			let filled = 0;
			while (filled < length) {
				const bytesRead = await readAt(fd, buffer, filled, length - filled, start + filled);
				if (bytesRead === 0) {
					break;
				}
				filled += bytesRead;
			}
			yield filled === length ? buffer : buffer.subarray(0, filled);
		})());
	}

	/**
	 * yauzl reads each directory record through here. Copying from the buffer
	 * skips the per-read stream pipeline entirely, which is most of the cost of
	 * indexing tens of thousands of entries.
	 */
	read(buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | null) => void): void {
		const directoryEnd = this.directoryStart + this.directory.length;
		if (position >= this.directoryStart && position + length <= directoryEnd) {
			const from = position - this.directoryStart;
			this.directory.copy(buffer, offset, from, from + length);
			// Never call back synchronously: yauzl drives the entry loop from here.
			queueMicrotask(() => callback(null));
			return;
		}
		readAt(this.fd, buffer, offset, length, position).then(() => callback(null)).catch(callback);
	}

	/** yauzl's close hook, reached when the ZipFile releases its last reference. */
	close(callback: (err: Error | null) => void): void {
		closeFd(this.fd, err => callback(err ?? null));
	}
}

export async function openZip(zipPath: string): Promise<ZipFile> {
	const fallback = async (): Promise<ZipFile> => new Promise((resolve, reject) => {
		open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(zip);
		});
	});

	let fd: number;
	try {
		fd = await new Promise<number>((resolve, reject) => {
			openFd(zipPath, 'r', (err, handle) => (err ? reject(err) : resolve(handle)));
		});
	} catch {
		// Let yauzl produce the error message callers already expect.
		return fallback();
	}
	const abandon = async (): Promise<ZipFile> => {
		closeFd(fd, () => {});
		return fallback();
	};
	try {
		const size = await new Promise<number>((resolve, reject) => {
			fstat(fd, (err, stats) => (err ? reject(err) : resolve(stats.size)));
		});
		const tailStart = Math.max(0, size - EOCD_SEARCH_BYTES);
		const tail = Buffer.alloc(size - tailStart);
		await readAt(fd, tail, 0, tail.length, tailStart);
		const central = findCentralDirectory(tail, tailStart);
		if (!central) {
			return await abandon();
		}
		const directory = Buffer.alloc(central.size);
		await readAt(fd, directory, 0, central.size, central.offset);
		const reader = new BufferedDirectoryReader(zipPath, fd, directory, central.offset);
		return await new Promise<ZipFile>((resolve, reject) => {
			fromRandomAccessReader(reader, size, { lazyEntries: true, autoClose: false }, (err, zip) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(zip);
			});
		});
	} catch {
		return abandon();
	}
}
