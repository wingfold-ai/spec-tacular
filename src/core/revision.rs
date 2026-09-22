//! Turns rejections into a revision instruction for the agent.
//!
//! Rejecting a requirement has to *do* something, or the review loop is just
//! bookkeeping. The bundle collects every rejection with its reason so the
//! agent rewrites exactly those requirements and leaves the accepted ones
//! alone — which is the whole point of reviewing them individually
//! (docs/problem-analysis.md §3).
//!
//! Lands in stage 2.
