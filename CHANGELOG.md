# Change Log

All notable changes to the "claude-code-chat" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.9] - 2025-06-19

### Added
- Model selector dropdown in the chat interface
  - Located to the left of the tools selector at the bottom of the chat box
  - Supports three models: Opus (most capable), Sonnet (balanced), and Default (smart allocation)
  - Model preference is saved and persists across sessions
  - Validates model selection to prevent invalid model names
  - Shows confirmation message when switching models

### Changed
- Reorganized input controls into left-controls and right-controls sections for better layout
- Claude command now includes the --model flag when a specific model is selected

## [0.0.8] - 2025-06-19

### Added
- WSL (Windows Subsystem for Linux) configuration support
  - New setting: `claudeCodeChat.wsl.enabled` to enable WSL integration
  - New setting: `claudeCodeChat.wsl.distro` to specify WSL distribution
  - New setting: `claudeCodeChat.wsl.nodePath` to configure Node.js path in WSL
  - New setting: `claudeCodeChat.wsl.claudePath` to configure Claude path in WSL
- Automatic detection of execution environment (native vs WSL)
- WSL support for Claude login terminal command

### Changed
- Claude execution now supports both native and WSL environments based on configuration
- Terminal login command adapts to WSL settings when enabled

## [0.0.7] - Previous Release

- Initial release