//! Minimal Yjs wire-format helpers (lib0-compatible varUint / varUint8Array).
//!
//! Yjs messages are framed as:
//!   [messageType : varUint, message definition...]
//! A varUint is a little-endian base-128 integer (LEB128): bytes carry 7 bits
//! each, high bit set on continuation bytes. A varUint8Array is a varUint
//! length followed by that many raw bytes.

/// Read a lib0 varUint from `data` starting at `pos`.
pub fn read_var_uint(data: &[u8], pos: &mut usize) -> Option<u32> {
    let mut num: u32 = 0;
    let mut shift: u32 = 0;
    loop {
        let b = *data.get(*pos)?;
        *pos += 1;
        num |= ((b & 0x7F) as u32) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 35 {
            return None;
        }
    }
    Some(num)
}

/// Read a lib0 varUint8Array as a zero-copy subslice from `data` starting at `pos`.
pub fn read_var_u8slice<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let len = read_var_uint(data, pos)? as usize;
    let end = pos.checked_add(len)?;
    if end > data.len() {
        return None;
    }
    let slice = &data[*pos..end];
    *pos = end;
    Some(slice)
}

/// Read a lib0 varUint8Array from `data` starting at `pos`.
pub fn read_var_u8array(data: &[u8], pos: &mut usize) -> Option<Vec<u8>> {
    read_var_u8slice(data, pos).map(|s| s.to_vec())
}

/// Read a lib0 varString as a zero-copy &str from `data` starting at `pos`.
pub fn read_var_str<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a str> {
    let slice = read_var_u8slice(data, pos)?;
    std::str::from_utf8(slice).ok()
}

/// Append a lib0 varUint to `out`.
pub fn write_var_uint(out: &mut Vec<u8>, mut num: u32) {
    loop {
        let mut byte = (num & 0x7F) as u8;
        num >>= 7;
        if num != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if num == 0 {
            break;
        }
    }
}

/// Append a lib0 varUint8Array to `out`.
pub fn write_var_u8array(out: &mut Vec<u8>, bytes: &[u8]) {
    write_var_uint(out, bytes.len() as u32);
    out.extend_from_slice(bytes);
}

/// Read a lib0 varString (length-prefixed UTF-8) from `data` starting at `pos`.
#[allow(dead_code)]
pub fn read_var_string(data: &[u8], pos: &mut usize) -> Option<String> {
    let bytes = read_var_u8array(data, pos)?;
    String::from_utf8(bytes).ok()
}

/// Append a lib0 varString (length-prefixed UTF-8) to `out`.
pub fn write_var_string(out: &mut Vec<u8>, s: &str) {
    write_var_u8array(out, s.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_small_and_large_uint() {
        for value in [0u32, 1, 127, 128, 300, 16_384, 1_000_000, u32::MAX] {
            let mut out = Vec::new();
            write_var_uint(&mut out, value);
            let mut pos = 0;
            assert_eq!(read_var_uint(&out, &mut pos), Some(value));
            assert_eq!(pos, out.len());
        }
    }

    #[test]
    fn roundtrips_u8array() {
        let bytes = vec![1u8, 2, 3, 4, 255, 0, 42];
        let mut frame = Vec::new();
        write_var_u8array(&mut frame, &bytes);
        let mut pos = 0;
        assert_eq!(read_var_u8array(&frame, &mut pos), Some(bytes));
        assert_eq!(pos, frame.len());
    }
}