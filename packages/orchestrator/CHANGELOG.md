# Changelog

## [Unreleased]

### Fixed

- Forward configured `provider` and `model` to spawned RPC child processes instead of dropping them (G-8.2)
- Escalate `dispose()` to `SIGKILL` after a 5s `SIGTERM` grace period so a child ignoring `SIGTERM` can no longer hang shutdown (G-8.3)

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
