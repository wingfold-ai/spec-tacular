//! The boundary between spec-tacular and OpenSpec.
//!
//! Everything that knows OpenSpec exists lives under here, and nothing outside
//! it does. `core/` is written against plain data; swapping, versioning or
//! stubbing OpenSpec is therefore a change to this directory alone
//! (docs/architecture.md).

pub mod openspec;
pub mod types;
