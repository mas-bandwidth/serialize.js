# serialize.js

[![CI](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml/badge.svg)](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

A bitpacking serialization library for **JavaScript**. The sixth
implementation of the serialize family, wire compatible with the
[C++](https://github.com/mas-bandwidth/serialize),
[C](https://github.com/mas-bandwidth/serialize.c),
[Go](https://github.com/mas-bandwidth/serialize.go),
[C#](https://github.com/mas-bandwidth/serialize.cs) and
[Rust](https://github.com/mas-bandwidth/serialize.rs) libraries — the same
values produce the same bytes in all six, so a stream written by one reads in
any other.

## Status

**Under construction**, being built chunk by chunk. What exists right now:

- [STANDARD.md](STANDARD.md) — the wire format specification, vendored
  verbatim from [mas-bandwidth/serialize](https://github.com/mas-bandwidth/serialize).
  CI diffs it against upstream on every push.
- The package scaffold: ESM, zero dependencies, no build step, Node 20+,
  tested with node's built-in `node:test` runner on Linux, macOS and Windows.

The library itself lands next, starting with the bitpacker.

## Design

This is a **hand-port to native JavaScript** — no wasm. It takes the family's
checked-runtime shape: checks run in every build, reads validate everything
(the wire is a trust boundary), and errors are values — bool-returning
serialize methods plus a sticky latched stream error. Hostile input never
throws.

## Testing

```
npm test
```

which is nothing more than `node --test test/`.

## License

[BSD 3-Clause](LICENSE), © Más Bandwidth LLC.
