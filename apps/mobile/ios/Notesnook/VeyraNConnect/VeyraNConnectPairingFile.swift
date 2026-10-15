/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// A bounded, symlink-safe reader for the operator's `connection.export.json`.
//
// The picked document is plain local JSON that carries the app credential. It
// is read once through an `O_NOFOLLOW | O_NONBLOCK` descriptor whose `fstat`
// must prove a regular file, owned by the current effective user, with exactly
// mode 0600 and at most 64 KiB. Any other result — a symlink, a device/fifo, a
// different owner, any group/other bit, a broader owner mode such as 0644 or
// 0700, an oversized file or a malformed document — fails closed and reads
// nothing. `O_NONBLOCK` guarantees a FIFO can never block `open` before the
// `fstat` that rejects it.
//
// Imports Foundation/Darwin only: no UIKit, no React. The standalone harness
// drives this exact reader against real temporary files.

import Foundation

enum VeyraNConnectPairingFileReader {
  enum ReadError: Error, Equatable {
    case insecure
    case unreadable
    case tooLarge
    case invalid
  }

  /// Read and validate a pairing document from a local file path.
  static func read(path: String) -> Result<VeyraNConnectPairing, ReadError> {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard descriptor >= 0 else {
      // ELOOP (a symlink) and EACCES both land here: fail closed, never follow.
      return .failure(errno == ELOOP ? .insecure : .unreadable)
    }
    defer { close(descriptor) }

    var info = stat()
    guard fstat(descriptor, &info) == 0 else { return .failure(.unreadable) }
    guard (info.st_mode & S_IFMT) == S_IFREG else {
      return .failure(.insecure)
    }
    guard info.st_uid == geteuid() else { return .failure(.insecure) }
    // Exactly 0600: this rejects 0644 (group/other readable) *and* 0400/0700
    // for which the documented contract is 0600.
    guard (info.st_mode & 0o777) == 0o600 else { return .failure(.insecure) }

    let size = Int(info.st_size)
    guard size > 0, size <= VeyraNConnectWire.maxPairingFileBytes else {
      return .failure(size > VeyraNConnectWire.maxPairingFileBytes ? .tooLarge : .invalid)
    }

    var data = Data(count: size)
    let read = data.withUnsafeMutableBytes { buffer -> Int in
      guard let base = buffer.baseAddress else { return -1 }
      var total = 0
      while total < size {
        let count = pread(descriptor, base + total, size - total, off_t(total))
        if count <= 0 { return count < 0 ? -1 : total }
        total += count
      }
      return total
    }
    guard read == size else { return .failure(.unreadable) }
    guard let pairing = VeyraNConnectPairing.parse(data: data) else {
      return .failure(.invalid)
    }
    return .success(pairing)
  }
}
