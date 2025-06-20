# Change Log

All notable changes to the "claude-code-chat" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.2] - 2025-06-20

### 🐛 Bug Fixes
- Fixed markdown parsing bug where underscores in code identifiers (like "protein_id") were incorrectly converted to italic formatting
- Updated regex pattern to only apply italic formatting when underscores are surrounded by whitespace or at string boundaries
- Preserved proper formatting for code snippets and technical identifiers
- Always show New Chat button

## [0.1.0] - 2025-06-20

### 🚀 Major Features Added

#### **Interactive Thinking Mode with Intensity Control**
- Added configurable thinking mode with 4 intensity levels: Think, Think Hard, Think Harder, Ultrathink
- Beautiful slider interface in settings for intensity selection
- Clickable intensity labels for easy selection
- Different thinking prompts based on selected intensity level
- Higher intensities provide more detailed reasoning but consume more tokens
- Settings persist across sessions with VS Code configuration integration

#### **Plan First Mode**
- New toggle for "Plan First" mode that instructs Claude to plan before making changes
- Requires user approval before proceeding with implementation
- Safer experimentation workflow for complex changes
- Simple switch interface above the text input area

#### **Slash Commands Modal System**
- Type "/" to open beautiful slash commands modal with 19+ commands
- Complete Claude Code command integration: /bug, /clear, /compact, /config, /cost, /doctor, /help, /init, /login, /logout, /mcp, /memory, /model, /permissions, /pr_comments, /review, /status, /terminal-setup, /vim
- Custom command input field for executing any Claude Code command
- Session-aware command execution with automatic session resumption
- Commands open in VS Code terminal with proper WSL support
- Visual feedback and user guidance for terminal interaction

#### **Enhanced Model Configuration**
- Updated "Default" model to show "User configured" instead of "Smart allocation"
- Added "Configure" button next to Default model option
- Configure button opens terminal with `claude /model` command for easy model setup
- Session-aware model configuration with current session context
- Clear user messaging about terminal interaction and return workflow

#### **Advanced Settings Management**
- Restructured settings with better organization and grouping
- Added "Coming Soon" sections for Custom Slash Commands and MCP Configuration
- Consistent UI patterns across all settings sections
- Clean, professional design matching VS Code aesthetics

### 🎨 **UI/UX Improvements**
- Smaller, more subtle mode toggle switches (reduced by 2px)
- Clickable text labels for all toggle switches
- Improved slider positioning and label alignment
- Sober, clean interface design without unnecessary colors or decorations
- Better visual hierarchy in settings modal
- Responsive design improvements

### 🔧 **Technical Enhancements**
- Session ID now passed to all slash commands for context awareness
- Improved message handling between frontend and backend
- Better error handling and user feedback
- Enhanced WSL compatibility for all new features
- Modular code structure for easier maintenance

### 📚 **Documentation Updates**
- Updated keyboard shortcuts documentation
- Enhanced configuration examples
- Improved feature descriptions and usage examples

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