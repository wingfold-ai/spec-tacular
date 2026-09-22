# Export capability

## ADDED Requirements

### Requirement: Data export
The system SHALL let a user export their data in a portable format. The format
is {{example: NDJSON}} until someone decides otherwise.

#### Scenario: Export succeeds
- **WHEN** the user asks for an export
- **THEN** a file is produced

#### Scenario: Export is empty
- **WHEN** there is nothing to export
- **THEN** an empty file is produced, not an error

### Requirement: Export notification
The system SHALL notify the user when an export finishes.

The notification names the file.

#### Scenario: Notified on success
- **WHEN** the export finishes
- **THEN** the user is told where the file is

## MODIFIED Requirements

### Requirement: Import
The system SHALL import a previously exported file.

A spec is allowed to show what a requirement looks like:

```md
### Requirement: Not a real requirement
This heading lives inside a fence and must never be parsed.

#### Scenario: Also fake
- **WHEN** parsed
- **THEN** it is ignored
```

#### Scenario: Round trip
- **WHEN** an exported file is imported
- **THEN** the data matches

## RENAMED Requirements

- FROM: `### Requirement: Old name`
- TO: `### Requirement: New name`
