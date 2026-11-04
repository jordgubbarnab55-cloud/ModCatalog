# The `.utoc` metadata trailer (format v1, payload schema 1)

A self-describing block appended to a UE 5.6 `.utoc` at exactly `TocEnd`.
The engine reads only the header-declared sections, so bytes after them are
never read; encrypted and signed containers stay valid (the trailer is outside
the encrypted regions and the signature). OnDemand containers are read-only.

## `.utoc` header (TOC version 8, little-endian, 144 bytes)

| offset | size | field | rule |
|---|---|---|---|
| 0x00 | 16 | magic | `-==--==--==--==-` (else `BadMagic`) |
| 0x10 | 1 | version | 8 = known layout; other = scan mode on read, refused on write |
| 0x14 | 4 | tocHeaderSize | must be 144 (else `BadHeaderSize`) |
| 0x18 | 4 | tocEntryCount | |
| 0x1C | 4 | tocCompressedBlockEntryCount | |
| 0x20 | 4 | tocCompressedBlockEntrySize | must be 12 (else `BadHeaderSize`) |
| 0x24 | 4 | compressionMethodNameCount | |
| 0x30 | 4 | directoryIndexSize | |
| 0x50 | 1 | containerFlags | 0x04 Signed, 0x08 Indexed, 0x10 OnDemand |
| 0x54 | 4 | tocChunkPerfectHashSeedsCount | |
| 0x60 | 4 | tocChunksWithoutPerfectHashCount | |

A file under 144 bytes is `NotAToc`.

```
SignedOff = 144 + 22*entries + 4*seeds + 4*noHash + 12*blocks + 32*methods
TocEnd    = SignedOff
          + (Signed  ? 4 + 2*hashSize + 20*blocks : 0)   // hashSize = i32 at SignedOff
          + (Indexed ? directoryIndexSize          : 0)
          + 24*entries
```

`TocEnd < 144` or `TocEnd > fileSize` (or `SignedOff + 4 > fileSize`) is
`TocEndMismatch`.

## Trailer layout

```
0x00  8 B  magic "UEMODMET"
0x08  u16  format_version = 1
0x0A  6 B  reserved, zero
0x10  u64  total_size   (multiple of 65536; header + payload + zero padding)
0x18  u32  payload_size
0x1C  u32  payload_crc32 (CRC-32/ISO-HDLC of the payload)
0x20  payload, then zero padding to total_size
```

Parse order and error kinds: magic → format_version (`UnsupportedTrailerVersion`)
→ reserved (`SchemaViolation`) → alignment (`SchemaViolation`) →
`total_size < 0x20 + payload_size` (`SchemaViolation`) → `total_size` past EOF
(`TruncatedTrailer`) → payload past EOF (`TruncatedTrailer`) → CRC (`BadCrc`)
→ JSON → schema.

## Payload (compact UTF-8 JSON, no BOM)

Written with keys in this order; `tags` omitted when empty, `image` when absent:

| key | rule |
|---|---|
| `schema` | integer, must be 1 |
| `title` | 1..256 |
| `author` | 1..256 |
| `description` | 0..16384 |
| `version` | 0..64 (may be empty) |
| `game_version` | 0..64; absent = "" |
| `guid` | required; RFC 4122 shape, case-insensitive on read, written and reported lowercase |
| `identifier` | absent/empty = derived `"{author}.{title}"` with all whitespace removed; ≤ 513 |
| `tags` | ≤ 10, each non-blank and ≤ 32, no case-insensitive duplicates. Structural only — the vocabulary (`tags.json`) is applied by consumers, not here |
| `image` | `{ "mime": "image/png" \| "image/jpeg", "data": base64 }`, decoded ≤ 4 MiB (`ImageTooLarge`), magic bytes must match the mime (`ImageMimeMismatch`); another mime is `SchemaViolation` |

All lengths count **UTF-16 code units** (C# `string.Length`, JS `.length`).

JSON reading follows System.Text.Json into typed fields:

- not JSON, not an object, or a wrong JSON type (a number for `title`, a
  string for `tags`, a non-string tag) → `BadJson`;
- `null` for a string field = empty; a missing key = empty (`schema` missing = 0);
- unknown keys are ignored;
- then: `schema != 1` → image base64 decode (`null` data = empty bytes; bad
  base64 = `SchemaViolation`) → missing guid → field rules above. Field-rule
  failures are `SchemaViolation` except the two image kinds.

JSON writing matches System.Text.Json with `UnsafeRelaxedJsonEscaping`: `"`
`\` and `\n \r \t \b \f` use short escapes, other controls `\u00XX`
(uppercase hex), characters above U+FFFF as uppercase surrogate-pair escapes
(`🚀`), everything else raw UTF-8.

## Read

1. Parse the header (errors above).
2. Version ≠ 8 → scan mode (warning): skip to step 5 with `TocEnd` unknown.
3. Compute `TocEnd`; `TocEnd == size` → **none**.
4. Magic at `TocEnd` → parse strictly there: any error is **raised**.
5. Scan for the magic from `max(size − 1 MiB, TocEnd)`; the first candidate
   that parses cleanly wins; failing candidates are skipped. Nothing →
   **none** (warning: unknown trailing data).

## Write

Refuse OnDemand (`OnDemandRefused`) and version ≠ 8 (`UnsupportedVersion`);
compute `TocEnd`. Bytes after `TocEnd` must be exactly one valid trailer
(replaced; its GUID is kept when the new metadata has none) — anything else
is `ForeignTrailer`. A missing GUID with no existing trailer gets a fresh v4.
Validate, serialize, write `file[0:TocEnd] + trailer` (the prefix stays
byte-identical; writers on disk replace atomically).

Strip = the same checks, then truncate to `TocEnd`.

## Error kinds

`NotAToc`, `BadMagic`, `BadHeaderSize`, `UnsupportedVersion`, `TocEndMismatch`,
`ForeignTrailer`, `TruncatedTrailer`, `BadCrc`, `BadJson`, `SchemaViolation`,
`UnsupportedTrailerVersion`, `ImageTooLarge`, `ImageMimeMismatch`,
`OnDemandRefused` (plus the C#-only file-system kinds `Io`, `FileLocked`).
