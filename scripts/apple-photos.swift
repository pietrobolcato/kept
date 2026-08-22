import AppKit
import Foundation
import Photos

struct AlbumSummary: Codable {
    let id: String
    let name: String
    let count: Int
}

struct ExportSummary: Codable {
    let exported: Int
    let skipped: Int
}

enum ImporterError: Error, LocalizedError {
    case usage
    case accessDenied
    case albumMissing
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .usage: return "Usage: KeptPhotosImporter status | authorize | list | export <album-id> <folder>"
        case .accessDenied: return "Photos access was not granted. Allow Kept Photos Importer in System Settings → Privacy & Security → Photos."
        case .albumMissing: return "The selected Photos album no longer exists."
        case .exportFailed(let name): return "Could not render \(name)."
        }
    }
}

func authorizationName(_ status: PHAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .limited: return "limited"
    @unknown default: return "unknown"
    }
}

func authorizePhotos() throws {
    var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.activate(ignoringOtherApps: true)
        var finished = false
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { nextStatus in
            status = nextStatus
            finished = true
        }
        while !finished {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
        }
    }
    guard status == .authorized || status == .limited else { throw ImporterError.accessDenied }
}

func albums() -> [AlbumSummary] {
    let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
    var results: [AlbumSummary] = []
    collections.enumerateObjects { collection, _, _ in
        let count = PHAsset.fetchAssets(in: collection, options: nil).count
        results.append(AlbumSummary(id: collection.localIdentifier, name: collection.localizedTitle ?? "Untitled album", count: count))
    }
    return results.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
}

func safeFilename(_ value: String) -> String {
    let invalid = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_ ")).inverted
    let cleaned = value.components(separatedBy: invalid).joined(separator: "-").trimmingCharacters(in: CharacterSet(charactersIn: "- "))
    return cleaned.isEmpty ? "photo" : String(cleaned.prefix(100))
}

func renderedJpeg(for asset: PHAsset) -> Data? {
    let options = PHImageRequestOptions()
    options.isSynchronous = true
    options.isNetworkAccessAllowed = true
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .exact
    var rendered: NSImage?
    PHImageManager.default().requestImage(
        for: asset,
        targetSize: NSSize(width: 2400, height: 2400),
        contentMode: .aspectFit,
        options: options
    ) { image, _ in
        rendered = image
    }
    guard let tiff = rendered?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
    return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9])
}

func exportAlbum(id: String, to destination: URL) throws -> ExportSummary {
    let result = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
    guard let album = result.firstObject else { throw ImporterError.albumMissing }
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    let assets = PHAsset.fetchAssets(in: album, options: nil)
    var exported = 0
    var skipped = 0
    assets.enumerateObjects { asset, index, _ in
        guard asset.mediaType == .image else {
            skipped += 1
            return
        }
        let originalName = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "photo-\(index + 1)"
        let stem = safeFilename((originalName as NSString).deletingPathExtension)
        let filename = String(format: "%04d-%@.jpg", index + 1, stem)
        guard let data = renderedJpeg(for: asset) else {
            skipped += 1
            return
        }
        do {
            try data.write(to: destination.appendingPathComponent(filename), options: .atomic)
            exported += 1
        } catch {
            skipped += 1
        }
    }
    return ExportSummary(exported: exported, skipped: skipped)
}

func printJson<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data([0x0A]))
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw ImporterError.usage }
    if command == "status" {
        try printJson(["status": authorizationName(PHPhotoLibrary.authorizationStatus(for: .readWrite))])
    } else if command == "authorize" {
        try authorizePhotos()
        try printJson(["status": authorizationName(PHPhotoLibrary.authorizationStatus(for: .readWrite))])
    } else if command == "list" {
        try authorizePhotos()
        try printJson(albums())
    } else if command == "export", arguments.count == 3 {
        try authorizePhotos()
        try printJson(try exportAlbum(id: arguments[1], to: URL(fileURLWithPath: arguments[2], isDirectory: true)))
    } else {
        throw ImporterError.usage
    }
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
