//! The Runtime's local HTTP surface, grouped by domain. Every handler lives in
//! one of the sibling modules; this file only wires them together and
//! re-exports them under `crate::api::*` so the router in `lib.rs` and the
//! other modules keep the paths they already use.

mod agents;
mod approvals;
mod assets;
mod boards;
mod clone;
mod context_links;
mod data;
mod events;
mod exports;
mod files;
mod git;
mod health;
mod search;
mod settings;
mod support;
mod terminals;
mod usage;
mod workspaces;

#[cfg(test)]
mod tests;

pub use self::{
    agents::*, approvals::*, assets::*, boards::*, clone::*, context_links::*, data::*, events::*,
    exports::*, files::*, git::*, health::*, search::*, settings::*, support::*, terminals::*,
    usage::*, workspaces::*,
};
