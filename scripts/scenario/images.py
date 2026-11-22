"""Ticket v1b-05 helpers: generated fixture images and the system pasteboard fingerprint.

`pasteboard()` reads (never writes) every type on the general pasteboard through JXA and returns
{changeCount, types: {type: sha256}}: equal before and after proves the clipboard was not touched.
"""
import base64, hashlib, json, struct, subprocess, zlib

JXA = r'''
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const out = {changeCount: Number(pb.changeCount), types: {}};
const types = pb.types;
for (let i = 0; types && i < types.count; i++) {
  const t = ObjC.unwrap(types.objectAtIndex(i));
  const d = pb.dataForType(t);
  out.types[t] = d && !d.isNil() ? ObjC.unwrap(d.base64EncodedStringWithOptions(0)) : null;
}
JSON.stringify(out);
'''


def pasteboard():
    raw = json.loads(subprocess.run(['osascript', '-l', 'JavaScript', '-e', JXA], capture_output=True, text=True, check=True).stdout)
    types = {t: (hashlib.sha256(base64.b64decode(v)).hexdigest() if v is not None else None) for t, v in raw['types'].items()}
    return {'changeCount': raw['changeCount'], 'types': types}


def png(width, height, rgb):
    """A solid-colour PNG, built with zlib only."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    row = b'\x00' + bytes(rgb) * width
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    print(json.dumps(pasteboard(), indent=1))
