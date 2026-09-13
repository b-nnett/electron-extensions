import Darwin
import Foundation

public enum RuntimeBoundedFile {
    /// Nil means absent. Invalid type, growth, and permission errors are never
    /// treated as an empty file. O_NONBLOCK prevents a substituted FIFO blocking.
    public static func read(_ url: URL, maximumBytes: Int) throws -> Data? {
        guard url.isFileURL, maximumBytes >= 0, maximumBytes < Int.max else { throw invalid() }
        let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = stat()
        guard fstat(fd, &before) == 0,
              before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_size >= 0, before.st_size <= maximumBytes else { throw invalid() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        var after = stat()
        guard data.count <= maximumBytes, data.count == before.st_size,
              fstat(fd, &after) == 0, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw invalid() }
        return data
    }

    private static func invalid() -> NSError {
        NSError(domain: "ExtensionsAnywhere.BoundedFile", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The file is invalid, changed while reading, or exceeds its size limit."])
    }
}
