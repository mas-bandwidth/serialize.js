// Load-time mode selection: the JavaScript #ifdef.
//
// The family's check model (STANDARD.md, "Writes assume trusted data") makes
// the caller responsible for well-formed writes: writer contracts are
// assertions in a CHECKED BUILD -- the standard's term for a build with
// assertions enabled -- and release builds carry zero caller validation on
// the write path. JavaScript has no compiler to strip code, so the same fork
// happens at MODULE LOAD instead: NODE_ENV is read exactly once, here, and
// each write-path class is exported in one of
// two variants -- CHECKED (caller validation on: misuse throws, invalid
// values latch -- the development default) or PRODUCTION (caller-trust:
// per-operation caller validation removed; only the checks the family keeps
// hard in release remain -- see the production classes for exactly what
// stays).
//
// The selection is FROZEN: nothing re-reads the environment per call, so
// changing NODE_ENV after load has no effect -- the semantics of a compiled
// build. Selecting whole classes at export time (rather than branching on a
// flag inside shared bodies) keeps the production instruction stream free of
// dead validation and every call site monomorphic: a process only ever
// instantiates one variant of each class.
export const PRODUCTION = process.env.NODE_ENV === 'production';
