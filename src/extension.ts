import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';

const exec = util.promisify(cp.exec);

export function activate(context: vscode.ExtensionContext) {
	const provider = new ClaudeChatProvider(context.extensionUri, context);

	const disposable = vscode.commands.registerCommand('claude-code-chat.openChat', () => {
		provider.show();
	});

	const loadConversationDisposable = vscode.commands.registerCommand('claude-code-chat.loadConversation', (filename: string) => {
		provider.loadConversation(filename);
	});

	// Register tree data provider for the activity bar view
	const treeProvider = new ClaudeChatViewProvider(context.extensionUri, context, provider);
	vscode.window.registerTreeDataProvider('claude-code-chat.chat', treeProvider);

	// Make tree provider accessible to chat provider for refreshing
	provider.setTreeProvider(treeProvider);


	// Create status bar item
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = "Claude";
	statusBarItem.tooltip = "Open Claude Code Chat (Ctrl+Shift+C)";
	statusBarItem.command = 'claude-code-chat.openChat';
	statusBarItem.show();

	context.subscriptions.push(disposable, loadConversationDisposable, statusBarItem);
}

export function deactivate() { }

class ClaudeChatViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

	constructor(
		private extensionUri: vscode.Uri,
		private context: vscode.ExtensionContext,
		private chatProvider: ClaudeChatProvider
	) { }

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): vscode.TreeItem[] {
		const items: vscode.TreeItem[] = [];

		// Add "Open Claude Code Chat" item
		const openChatItem = new vscode.TreeItem('Open Claude Code Chat', vscode.TreeItemCollapsibleState.None);
		openChatItem.command = {
			command: 'claude-code-chat.openChat',
			title: 'Open Claude Code Chat'
		};
		openChatItem.iconPath = vscode.Uri.joinPath(this.extensionUri, 'icon.png');
		openChatItem.tooltip = 'Open Claude Code Chat (Ctrl+Shift+C)';
		items.push(openChatItem);

		// Add conversation history items
		const conversationIndex = this.context.workspaceState.get('claude.conversationIndex', []) as any[];

		if (conversationIndex.length > 0) {
			// Add separator
			const separatorItem = new vscode.TreeItem('Recent Conversations', vscode.TreeItemCollapsibleState.None);
			separatorItem.description = '';
			separatorItem.tooltip = 'Click on any conversation to load it';
			items.push(separatorItem);

			// Add conversation items (show only last 5 for cleaner UI)
			conversationIndex.slice(0, 20).forEach((conv, index) => {
				const item = new vscode.TreeItem(
					conv.firstUserMessage.substring(0, 50) + (conv.firstUserMessage.length > 50 ? '...' : ''),
					vscode.TreeItemCollapsibleState.None
				);
				item.description = new Date(conv.startTime).toLocaleDateString();
				item.tooltip = `First: ${conv.firstUserMessage}\nLast: ${conv.lastUserMessage}\nMessages: ${conv.messageCount}, Cost: $${conv.totalCost.toFixed(3)}`;
				item.command = {
					command: 'claude-code-chat.loadConversation',
					title: 'Load Conversation',
					arguments: [conv.filename]
				};
				item.iconPath = new vscode.ThemeIcon('comment-discussion');
				items.push(item);
			});
		}

		return items;
	}
}

class ClaudeChatProvider {
	private _panel: vscode.WebviewPanel | undefined;
	private _disposables: vscode.Disposable[] = [];
	private _totalCost: number = 0;
	private _totalTokensInput: number = 0;
	private _totalTokensOutput: number = 0;
	private _requestCount: number = 0;
	private _currentSessionId: string | undefined;
	private _backupRepoPath: string | undefined;
	private _commits: Array<{ id: string, sha: string, message: string, timestamp: string }> = [];
	private _conversationsPath: string | undefined;
	private _currentConversation: Array<{ timestamp: string, messageType: string, data: any }> = [];
	private _conversationStartTime: string | undefined;
	private _conversationIndex: Array<{
		filename: string,
		sessionId: string,
		startTime: string,
		endTime: string,
		messageCount: number,
		totalCost: number,
		firstUserMessage: string,
		lastUserMessage: string
	}> = [];
	private _treeProvider: ClaudeChatViewProvider | undefined;
	private _currentClaudeProcess: cp.ChildProcess | undefined;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext
	) {

		// Initialize backup repository and conversations
		this._initializeBackupRepo();
		this._initializeConversations();

		// Load conversation index from workspace state
		this._conversationIndex = this._context.workspaceState.get('claude.conversationIndex', []);

		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;
	}

	public show() {
		const column = vscode.ViewColumn.Two;

		if (this._panel) {
			this._panel.reveal(column);
			return;
		}

		this._panel = vscode.window.createWebviewPanel(
			'claudeChat',
			'Claude Code Chat',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this._extensionUri]
			}
		);

		// Set icon for the webview tab using URI path
		const iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.png');
		this._panel.iconPath = iconPath;

		this._panel.webview.html = this._getHtmlForWebview();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.type) {
					case 'sendMessage':
						this._sendMessageToClaude(message.text);
						return;
					case 'newSession':
						this._newSession();
						return;
					case 'restoreCommit':
						this._restoreToCommit(message.commitSha);
						return;
					case 'getConversationList':
						this._sendConversationList();
						return;
					case 'getWorkspaceFiles':
						this._sendWorkspaceFiles(message.searchTerm);
						return;
					case 'selectImageFile':
						this._selectImageFile();
						return;
					case 'loadConversation':
						this.loadConversation(message.filename);
						return;
					case 'stopRequest':
						this._stopClaudeProcess();
						return;
				}
			},
			null,
			this._disposables
		);

		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;

		// Load latest conversation history if available
		if (latestConversation) {
			this._loadConversationHistory(latestConversation.filename);
		}

		// Send ready message immediately
		setTimeout(() => {
			// Send current session info if available
			if (this._currentSessionId) {
				this._panel?.webview.postMessage({
					type: 'sessionResumed',
					data: {
						sessionId: this._currentSessionId
					}
				});
			}

			this._panel?.webview.postMessage({
				type: 'ready',
				data: 'Ready to chat with Claude Code! Type your message below.'
			});
		}, 100);
	}

	private async _sendMessageToClaude(message: string) {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

		// Show user input in chat and save to conversation
		this._sendAndSaveMessage({
			type: 'userInput',
			data: message
		});

		// Set processing state
		this._panel?.webview.postMessage({
			type: 'setProcessing',
			data: true
		});

		// Create backup commit before Claude makes changes
		try {
			await this._createBackupCommit(message);
		}
		catch (e) {
			console.log("error", e)
		}

		// Show loading indicator
		this._panel?.webview.postMessage({
			type: 'loading',
			data: 'Claude is thinking...'
		});

		// Call claude with the message via stdin using stream-json format
		console.log('Calling Claude with message via stdin:', message);

		// Build command arguments with session management
		const args = [
			'-p',
			'--output-format', 'stream-json', '--verbose',
			'--dangerously-skip-permissions'
		];

		// Add session resume if we have a current session
		if (this._currentSessionId) {
			args.push('--resume', this._currentSessionId);
			console.log('Resuming session:', this._currentSessionId);
		} else {
			console.log('Starting new session');
		}

		console.log('Claude command args:', args);

		const claudeProcess = cp.spawn('claude', args, {
			cwd: cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				FORCE_COLOR: '0',
				NO_COLOR: '1'
			}
		});

		// Store process reference for potential termination
		this._currentClaudeProcess = claudeProcess;

		// Send the message to Claude's stdin
		if (claudeProcess.stdin) {
			claudeProcess.stdin.write(message + '\n');
			claudeProcess.stdin.end();
		}

		let rawOutput = '';
		let errorOutput = '';

		if (claudeProcess.stdout) {
			claudeProcess.stdout.on('data', (data) => {
				rawOutput += data.toString();

				// Process JSON stream line by line
				const lines = rawOutput.split('\n');
				rawOutput = lines.pop() || ''; // Keep incomplete line for next chunk

				for (const line of lines) {
					if (line.trim()) {
						try {
							const jsonData = JSON.parse(line.trim());
							this._processJsonStreamData(jsonData);
						} catch (error) {
							console.log('Failed to parse JSON line:', line, error);
						}
					}
				}
			});
		}

		if (claudeProcess.stderr) {
			claudeProcess.stderr.on('data', (data) => {
				errorOutput += data.toString();
			});
		}

		claudeProcess.on('close', (code) => {
			console.log('Claude process closed with code:', code);
			console.log('Claude stderr output:', errorOutput);

			// Clear process reference
			this._currentClaudeProcess = undefined;

			// Clear loading indicator
			this._panel?.webview.postMessage({
				type: 'clearLoading'
			});

			if (code !== 0 && errorOutput.trim()) {
				// Error with output
				this._sendAndSaveMessage({
					type: 'error',
					data: errorOutput.trim()
				});
			}
		});

		claudeProcess.on('error', (error) => {
			console.log('Claude process error:', error.message);
			
			// Clear process reference
			this._currentClaudeProcess = undefined;
			
			this._panel?.webview.postMessage({
				type: 'clearLoading'
			});
			
			// Check if claude command is not installed
			if (error.message.includes('ENOENT') || error.message.includes('command not found')) {
				this._sendAndSaveMessage({
					type: 'error',
					data: 'Install claude code first: https://www.anthropic.com/claude-code'
				});
			} else {
				this._sendAndSaveMessage({
					type: 'error',
					data: `Error running Claude: ${error.message}`
				});
			}
		});
	}

	private _processJsonStreamData(jsonData: any) {
		console.log('Received JSON data:', jsonData);

		switch (jsonData.type) {
			case 'system':
				if (jsonData.subtype === 'init') {
					// System initialization message - session ID will be captured from final result
					console.log('System initialized');
				}
				break;

			case 'assistant':
				if (jsonData.message && jsonData.message.content) {
					// Track token usage in real-time if available
					if (jsonData.message.usage) {
						this._totalTokensInput += jsonData.message.usage.input_tokens || 0;
						this._totalTokensOutput += jsonData.message.usage.output_tokens || 0;

						// Send real-time token update to webview
						this._sendAndSaveMessage({
							type: 'updateTokens',
							data: {
								totalTokensInput: this._totalTokensInput,
								totalTokensOutput: this._totalTokensOutput,
								currentInputTokens: jsonData.message.usage.input_tokens || 0,
								currentOutputTokens: jsonData.message.usage.output_tokens || 0,
								cacheCreationTokens: jsonData.message.usage.cache_creation_input_tokens || 0,
								cacheReadTokens: jsonData.message.usage.cache_read_input_tokens || 0
							}
						});
					}

					// Process each content item in the assistant message
					for (const content of jsonData.message.content) {
						if (content.type === 'text' && content.text.trim()) {
							// Show text content and save to conversation
							this._sendAndSaveMessage({
								type: 'output',
								data: content.text.trim()
							});
						} else if (content.type === 'thinking' && content.thinking.trim()) {
							// Show thinking content and save to conversation
							this._sendAndSaveMessage({
								type: 'thinking',
								data: content.thinking.trim()
							});
						} else if (content.type === 'tool_use') {
							// Show tool execution with better formatting
							const toolInfo = `🔧 Executing: ${content.name}`;
							let toolInput = '';

							if (content.input) {
								// Special formatting for TodoWrite to make it more readable
								if (content.name === 'TodoWrite' && content.input.todos) {
									toolInput = '\nTodo List Update:';
									for (const todo of content.input.todos) {
										const status = todo.status === 'completed' ? '✅' :
											todo.status === 'in_progress' ? '🔄' : '⏳';
										toolInput += `\n${status} ${todo.content} (priority: ${todo.priority})`;
									}
								} else {
									// Send raw input to UI for formatting
									toolInput = '';
								}
							}

							// Show tool use and save to conversation
							this._sendAndSaveMessage({
								type: 'toolUse',
								data: {
									toolInfo: toolInfo,
									toolInput: toolInput,
									rawInput: content.input,
									toolName: content.name
								}
							});
						}
					}
				}
				break;

			case 'user':
				if (jsonData.message && jsonData.message.content) {
					// Process tool results from user messages
					for (const content of jsonData.message.content) {
						if (content.type === 'tool_result') {
							let resultContent = content.content || 'Tool executed successfully';
							const isError = content.is_error || false;

							// Show tool result and save to conversation
							this._sendAndSaveMessage({
								type: 'toolResult',
								data: {
									content: resultContent,
									isError: isError,
									toolUseId: content.tool_use_id
								}
							});
						}
					}
				}
				break;

			case 'result':
				if (jsonData.subtype === 'success') {
					// Check for login errors
					if (jsonData.is_error && jsonData.result && jsonData.result.includes('Invalid API key')) {
						this._handleLoginRequired();
						return;
					}

					// Capture session ID from final result
					if (jsonData.session_id) {
						const isNewSession = !this._currentSessionId;
						const sessionChanged = this._currentSessionId && this._currentSessionId !== jsonData.session_id;

						console.log('Session ID found in result:', {
							sessionId: jsonData.session_id,
							isNewSession,
							sessionChanged,
							currentSessionId: this._currentSessionId
						});

						this._currentSessionId = jsonData.session_id;

						// Show session info in UI
						this._sendAndSaveMessage({
							type: 'sessionInfo',
							data: {
								sessionId: jsonData.session_id,
								tools: jsonData.tools || [],
								mcpServers: jsonData.mcp_servers || []
							}
						});
					}

					// Clear processing state
					this._panel?.webview.postMessage({
						type: 'setProcessing',
						data: false
					});

					// Update cumulative tracking
					this._requestCount++;
					if (jsonData.total_cost_usd) {
						this._totalCost += jsonData.total_cost_usd;
					}

					console.log('Result received:', {
						cost: jsonData.total_cost_usd,
						duration: jsonData.duration_ms,
						turns: jsonData.num_turns
					});

					// Send updated totals to webview
					this._panel?.webview.postMessage({
						type: 'updateTotals',
						data: {
							totalCost: this._totalCost,
							totalTokensInput: this._totalTokensInput,
							totalTokensOutput: this._totalTokensOutput,
							requestCount: this._requestCount,
							currentCost: jsonData.total_cost_usd,
							currentDuration: jsonData.duration_ms,
							currentTurns: jsonData.num_turns
						}
					});
				}
				break;
		}
	}


	private _newSession() {
		// Clear current session
		this._currentSessionId = undefined;

		// Clear commits and conversation
		this._commits = [];
		this._currentConversation = [];
		this._conversationStartTime = undefined;

		// Reset counters
		this._totalCost = 0;
		this._totalTokensInput = 0;
		this._totalTokensOutput = 0;
		this._requestCount = 0;

		// Notify webview to clear all messages and reset session
		this._panel?.webview.postMessage({
			type: 'sessionCleared'
		});
	}

	private _handleLoginRequired() {
		// Clear processing state
		this._panel?.webview.postMessage({
			type: 'setProcessing',
			data: false
		});

		// Show login required message
		this._panel?.webview.postMessage({
			type: 'loginRequired'
		});

		// Open terminal and run claude login
		const terminal = vscode.window.createTerminal('Claude Login');
		terminal.sendText('claude');
		terminal.show();

		// Show info message
		vscode.window.showInformationMessage(
			'Please login to Claude in the terminal, then come back to this chat to continue.',
			'OK'
		);
	}

	private async _initializeBackupRepo(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) {
				console.error('No workspace storage available');
				return;
			}
			console.log('Workspace storage path:', storagePath);
			this._backupRepoPath = path.join(storagePath, 'backups', '.git');

			// Create backup git directory if it doesn't exist
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._backupRepoPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._backupRepoPath));

				const workspacePath = workspaceFolder.uri.fsPath;

				// Initialize git repo with workspace as work-tree
				await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" init`);
				await exec(`git --git-dir="${this._backupRepoPath}" config user.name "Claude Code Chat"`);
				await exec(`git --git-dir="${this._backupRepoPath}" config user.email "claude@anthropic.com"`);

				console.log(`Initialized backup repository at: ${this._backupRepoPath}`);
			}
		} catch (error: any) {
			console.error('Failed to initialize backup repository:', error.message);
		}
	}

	private async _createBackupCommit(userMessage: string): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder || !this._backupRepoPath) return;

			const workspacePath = workspaceFolder.uri.fsPath;
			const now = new Date();
			const timestamp = now.toISOString().replace(/[:.]/g, '-');
			const displayTimestamp = now.toISOString();
			const commitMessage = `Before: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;

			// Add all files using git-dir and work-tree (excludes .git automatically)
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" add -A`);

			// Check if this is the first commit (no HEAD exists yet)
			let isFirstCommit = false;
			try {
				await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);
			} catch {
				isFirstCommit = true;
			}

			// Check if there are changes to commit
			const { stdout: status } = await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" status --porcelain`);

			// Always create a checkpoint, even if no files changed
			let actualMessage;
			if (isFirstCommit) {
				actualMessage = `Initial backup: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;
			} else if (status.trim()) {
				actualMessage = commitMessage;
			} else {
				actualMessage = `Checkpoint (no changes): ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;
			}

			// Create commit with --allow-empty to ensure checkpoint is always created
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" commit --allow-empty -m "${actualMessage}"`);
			const { stdout: sha } = await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);

			// Store commit info
			const commitInfo = {
				id: `commit-${timestamp}`,
				sha: sha.trim(),
				message: actualMessage,
				timestamp: displayTimestamp
			};

			this._commits.push(commitInfo);

			// Show restore option in UI and save to conversation
			this._sendAndSaveMessage({
				type: 'showRestoreOption',
				data: commitInfo
			});

			console.log(`Created backup commit: ${commitInfo.sha.substring(0, 8)} - ${actualMessage}`);
		} catch (error: any) {
			console.error('Failed to create backup commit:', error.message);
		}
	}


	private async _restoreToCommit(commitSha: string): Promise<void> {
		try {
			const commit = this._commits.find(c => c.sha === commitSha);
			if (!commit) {
				this._panel?.webview.postMessage({
					type: 'restoreError',
					data: 'Commit not found'
				});
				return;
			}

			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder || !this._backupRepoPath) {
				vscode.window.showErrorMessage('No workspace folder or backup repository available.');
				return;
			}

			const workspacePath = workspaceFolder.uri.fsPath;

			this._panel?.webview.postMessage({
				type: 'restoreProgress',
				data: 'Restoring files from backup...'
			});

			// Restore files directly to workspace using git checkout
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" checkout ${commitSha} -- .`);

			vscode.window.showInformationMessage(`Restored to commit: ${commit.message}`);

			this._sendAndSaveMessage({
				type: 'restoreSuccess',
				data: {
					message: `Successfully restored to: ${commit.message}`,
					commitSha: commitSha
				}
			});

		} catch (error: any) {
			console.error('Failed to restore commit:', error.message);
			vscode.window.showErrorMessage(`Failed to restore commit: ${error.message}`);
			this._panel?.webview.postMessage({
				type: 'restoreError',
				data: `Failed to restore: ${error.message}`
			});
		}
	}

	private async _initializeConversations(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) return;

			this._conversationsPath = path.join(storagePath, 'conversations');

			// Create conversations directory if it doesn't exist
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._conversationsPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._conversationsPath));
				console.log(`Created conversations directory at: ${this._conversationsPath}`);
			}
		} catch (error: any) {
			console.error('Failed to initialize conversations directory:', error.message);
		}
	}

	private _sendAndSaveMessage(message: { type: string, data: any }): void {
		// Initialize conversation if this is the first message
		if (this._currentConversation.length === 0) {
			this._conversationStartTime = new Date().toISOString();
		}

		if (message.type === 'sessionInfo') {
			message.data.sessionId
		}

		// Send to UI
		this._panel?.webview.postMessage(message);

		// Save to conversation
		this._currentConversation.push({
			timestamp: new Date().toISOString(),
			messageType: message.type,
			data: message.data
		});

		// Persist conversation
		void this._saveCurrentConversation();
	}

	private async _saveCurrentConversation(): Promise<void> {
		if (!this._conversationsPath || this._currentConversation.length === 0) return;

		try {
			// Create filename from first user message and timestamp
			const firstUserMessage = this._currentConversation.find(m => m.messageType === 'userInput');
			const firstMessage = firstUserMessage ? firstUserMessage.data : 'conversation';
			const startTime = this._conversationStartTime || new Date().toISOString();
			const sessionId = this._currentSessionId || 'unknown';

			// Clean and truncate first message for filename
			const cleanMessage = firstMessage
				.replace(/[^a-zA-Z0-9\s]/g, '') // Remove special chars
				.replace(/\s+/g, '-') // Replace spaces with dashes
				.substring(0, 50) // Limit length
				.toLowerCase();

			const datePrefix = startTime.substring(0, 16).replace('T', '_').replace(/:/g, '-');
			const filename = `${datePrefix}_${cleanMessage}.json`;

			const conversationData = {
				sessionId: sessionId,
				startTime: this._conversationStartTime,
				endTime: new Date().toISOString(),
				messageCount: this._currentConversation.length,
				totalCost: this._totalCost,
				totalTokens: {
					input: this._totalTokensInput,
					output: this._totalTokensOutput
				},
				messages: this._currentConversation,
				filename
			};

			const filePath = path.join(this._conversationsPath, filename);
			const content = new TextEncoder().encode(JSON.stringify(conversationData, null, 2));
			await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), content);

			// Update conversation index
			this._updateConversationIndex(filename, conversationData);

			console.log(`Saved conversation: ${filename}`, this._conversationsPath);
		} catch (error: any) {
			console.error('Failed to save conversation:', error.message);
		}
	}

	public setTreeProvider(treeProvider: ClaudeChatViewProvider): void {
		this._treeProvider = treeProvider;
	}

	public async loadConversation(filename: string): Promise<void> {
		// Show the webview first
		this.show();

		// Load the conversation history
		await this._loadConversationHistory(filename);
	}

	private _sendConversationList(): void {
		this._panel?.webview.postMessage({
			type: 'conversationList',
			data: this._conversationIndex
		});
	}

	private async _sendWorkspaceFiles(searchTerm?: string): Promise<void> {
		try {
			// Always get all files and filter on the backend for better search results
			const files = await vscode.workspace.findFiles(
				'**/*',
				'{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/.nuxt/**,**/target/**,**/bin/**,**/obj/**}',
				500 // Reasonable limit for filtering
			);

			let fileList = files.map(file => {
				const relativePath = vscode.workspace.asRelativePath(file);
				return {
					name: file.path.split('/').pop() || '',
					path: relativePath,
					fsPath: file.fsPath
				};
			});

			// Filter results based on search term
			if (searchTerm && searchTerm.trim()) {
				const term = searchTerm.toLowerCase();
				fileList = fileList.filter(file => {
					const fileName = file.name.toLowerCase();
					const filePath = file.path.toLowerCase();
					
					// Check if term matches filename or any part of the path
					return fileName.includes(term) || 
						   filePath.includes(term) ||
						   filePath.split('/').some(segment => segment.includes(term));
				});
			}

			// Sort and limit results
			fileList = fileList
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 50);

			this._panel?.webview.postMessage({
				type: 'workspaceFiles',
				data: fileList
			});
		} catch (error) {
			console.error('Error getting workspace files:', error);
			this._panel?.webview.postMessage({
				type: 'workspaceFiles',
				data: []
			});
		}
	}

	private async _selectImageFile(): Promise<void> {
		try {
			// Show VS Code's native file picker for images
			const result = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select image files',
				filters: {
					'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']
				}
			});
			
			if (result && result.length > 0) {
				// Send the selected file paths back to webview
				result.forEach(uri => {
					this._panel?.webview.postMessage({
						type: 'imagePath',
						path: uri.fsPath
					});
				});
			}
			
		} catch (error) {
			console.error('Error selecting image files:', error);
		}
	}

	private _stopClaudeProcess(): void {
		console.log('Stop request received');
		
		if (this._currentClaudeProcess) {
			console.log('Terminating Claude process...');
			
			// Try graceful termination first
			this._currentClaudeProcess.kill('SIGTERM');
			
			// Force kill after 2 seconds if still running
			setTimeout(() => {
				if (this._currentClaudeProcess && !this._currentClaudeProcess.killed) {
					console.log('Force killing Claude process...');
					this._currentClaudeProcess.kill('SIGKILL');
				}
			}, 2000);
			
			// Clear process reference
			this._currentClaudeProcess = undefined;
			
			// Update UI state
			this._panel?.webview.postMessage({
				type: 'setProcessing',
				data: false
			});
			
			this._panel?.webview.postMessage({
				type: 'clearLoading'
			});
			
			// Send stop confirmation message directly to UI and save
			this._sendAndSaveMessage({
				type: 'error',
				data: '⏹️ Claude code was stopped.'
			});
			
			console.log('Claude process termination initiated');
		} else {
			console.log('No Claude process running to stop');
		}
	}

	private _updateConversationIndex(filename: string, conversationData: any): void {
		// Extract first and last user messages
		const userMessages = conversationData.messages.filter((m: any) => m.messageType === 'userInput');
		const firstUserMessage = userMessages.length > 0 ? userMessages[0].data : 'No user message';
		const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].data : firstUserMessage;

		// Create or update index entry
		const indexEntry = {
			filename: filename,
			sessionId: conversationData.sessionId,
			startTime: conversationData.startTime,
			endTime: conversationData.endTime,
			messageCount: conversationData.messageCount,
			totalCost: conversationData.totalCost,
			firstUserMessage: firstUserMessage.substring(0, 100), // Truncate for storage
			lastUserMessage: lastUserMessage.substring(0, 100)
		};

		// Remove any existing entry for this session (in case of updates)
		this._conversationIndex = this._conversationIndex.filter(entry => entry.filename !== conversationData.filename);

		// Add new entry at the beginning (most recent first)
		this._conversationIndex.unshift(indexEntry);

		// Keep only last 50 conversations to avoid workspace state bloat
		if (this._conversationIndex.length > 50) {
			this._conversationIndex = this._conversationIndex.slice(0, 50);
		}

		// Save to workspace state
		this._context.workspaceState.update('claude.conversationIndex', this._conversationIndex);

		// Refresh tree view
		this._treeProvider?.refresh();
	}

	private _getLatestConversation(): any | undefined {
		return this._conversationIndex.length > 0 ? this._conversationIndex[0] : undefined;
	}

	private async _loadConversationHistory(filename: string): Promise<void> {
		console.log("_loadConversationHistory")
		if (!this._conversationsPath) return;

		try {
			const filePath = path.join(this._conversationsPath, filename);
			console.log("filePath", filePath)
			
			let conversationData;
			try {
				const fileUri = vscode.Uri.file(filePath);
				const content = await vscode.workspace.fs.readFile(fileUri);
				conversationData = JSON.parse(new TextDecoder().decode(content));
			} catch {
				return;
			}
			
			console.log("conversationData", conversationData)
			// Load conversation into current state
			this._currentConversation = conversationData.messages || [];
			this._conversationStartTime = conversationData.startTime;
			this._totalCost = conversationData.totalCost || 0;
			this._totalTokensInput = conversationData.totalTokens?.input || 0;
			this._totalTokensOutput = conversationData.totalTokens?.output || 0;

			// Clear UI messages first, then send all messages to recreate the conversation
			setTimeout(() => {
				// Clear existing messages
				this._panel?.webview.postMessage({
					type: 'sessionCleared'
				});

				// Small delay to ensure messages are cleared before loading new ones
				setTimeout(() => {
					for (const message of this._currentConversation) {
						this._panel?.webview.postMessage({
							type: message.messageType,
							data: message.data
						});
					}

					// Send updated totals
					this._panel?.webview.postMessage({
						type: 'updateTotals',
						data: {
							totalCost: this._totalCost,
							totalTokensInput: this._totalTokensInput,
							totalTokensOutput: this._totalTokensOutput,
							requestCount: this._requestCount
						}
					});
				}, 50);
			}, 100); // Small delay to ensure webview is ready

			console.log(`Loaded conversation history: ${filename}`);
		} catch (error: any) {
			console.error('Failed to load conversation history:', error.message);
		}
	}

	private _getHtmlForWebview(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Claude Code Chat</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			margin: 0;
			padding: 0;
			height: 100vh;
			display: flex;
			flex-direction: column;
		}

		.header {
			padding: 14px 20px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background-color: var(--vscode-panel-background);
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.header h2 {
			margin: 0;
			font-size: 16px;
			font-weight: 500;
			color: var(--vscode-foreground);
			letter-spacing: -0.3px;
		}

		.controls {
			display: flex;
			gap: 6px;
			align-items: center;
		}

		.btn {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: 1px solid var(--vscode-panel-border);
			padding: 6px 12px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 12px;
			font-weight: 400;
			transition: all 0.2s ease;
			display: flex;
			align-items: center;
			gap: 5px;
		}

		.btn:hover {
			background-color: var(--vscode-button-background);
			border-color: var(--vscode-focusBorder);
		}

		.btn.outlined {
			background-color: transparent;
			color: var(--vscode-foreground);
			border-color: var(--vscode-panel-border);
		}

		.btn.outlined:hover {
			background-color: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-focusBorder);
		}

		.btn.stop {
			background-color: transparent;
			color: var(--vscode-descriptionForeground);
			border: 1px solid rgba(255, 255, 255, 0.1);
			padding: 2px 6px;
			border-radius: 3px;
			font-size: 12px;
			font-weight: 400;
			opacity: 0.7;
		}

		.btn.stop:hover {
			background-color: rgba(231, 76, 60, 0.1);
			color: #e74c3c;
			border-color: rgba(231, 76, 60, 0.3);
			opacity: 1;
		}

		.chat-container {
			flex: 1;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		.messages {
			flex: 1;
			padding: 10px;
			overflow-y: auto;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			line-height: 1.4;
		}

		.message {
			margin-bottom: 10px;
			padding: 8px;
			border-radius: 4px;
		}

		.message.user {
			border: 1px solid rgba(100, 149, 237, 0.1);
			border-radius: 8px;
			color: var(--vscode-editor-foreground);
			position: relative;
			overflow: hidden;
		}

		.message.user::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			background: linear-gradient(180deg, #6495ed 0%, #4169e1 100%);
		}

		.message.claude {
			border: 1px solid rgba(46, 204, 113, 0.1);
			border-radius: 8px;
			color: var(--vscode-editor-foreground);
			position: relative;
			overflow: hidden;
		}

		.message.claude::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			background: linear-gradient(180deg, #2ecc71 0%, #27ae60 100%);
		}

		.message.error {
			border: 1px solid rgba(231, 76, 60, 0.3);
			border-radius: 8px;
			color: var(--vscode-editor-foreground);
			position: relative;
			overflow: hidden;
		}

		.message.error::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			background: linear-gradient(180deg, #e74c3c 0%, #c0392b 100%);
		}

		.message.system {
			background-color: var(--vscode-panel-background);
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}

		.message.tool {
			border: 1px solid rgba(64, 165, 255, 0.2);
			border-radius: 8px;
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-editor-font-family);
			position: relative;
			overflow: hidden;
		}

		.message.tool::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			background: linear-gradient(180deg, #40a5ff 0%, #0078d4 100%);
		}

		.message.tool-result {
			border: 1px solid rgba(28, 192, 140, 0.2);
			border-radius: 8px;
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-editor-font-family);
			white-space: pre-wrap;
			position: relative;
			overflow: hidden;
		}

		.message.tool-result::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			background: linear-gradient(180deg, #1cc08c 0%, #16a974 100%);
		}

		.message.thinking {
			border: 1px solid rgba(186, 85, 211, 0.2);
			border-radius: 8px;
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-editor-font-family);
			font-style: italic;
			opacity: 0.9;
			position: relative;
			overflow: hidden;
		}

		.message.thinking::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			background: linear-gradient(180deg, #ba55d3 0%, #9932cc 100%);
		}

		.tool-header {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 12px;
			padding-bottom: 8px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		}

		.tool-icon {
			width: 18px;
			height: 18px;
			border-radius: 4px;
			background: linear-gradient(135deg, #40a5ff 0%, #0078d4 100%);
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 10px;
			color: white;
			font-weight: 600;
			flex-shrink: 0;
		}

		.tool-info {
			font-weight: 500;
			font-size: 13px;
			color: var(--vscode-editor-foreground);
			opacity: 0.9;
		}

		.message-header {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 8px;
			padding-bottom: 6px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.08);
			position: relative;
		}

		.copy-btn {
			background: transparent;
			border: none;
			color: var(--vscode-descriptionForeground);
			cursor: pointer;
			padding: 2px;
			border-radius: 3px;
			opacity: 0;
			transition: opacity 0.2s ease;
			margin-left: auto;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.message:hover .copy-btn {
			opacity: 0.7;
		}

		.copy-btn:hover {
			opacity: 1;
			background-color: var(--vscode-list-hoverBackground);
		}

		.message-icon {
			width: 16px;
			height: 16px;
			border-radius: 3px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 10px;
			color: white;
			font-weight: 600;
			flex-shrink: 0;
			margin-left: 4px
		}

		.message-icon.user {
			background: linear-gradient(135deg, #6495ed 0%, #4169e1 100%);
		}

		.message-icon.claude {
			background: linear-gradient(135deg, #2ecc71 0%, #27ae60 100%);
		}

		.message-icon.system {
			background: linear-gradient(135deg, #95a5a6 0%, #7f8c8d 100%);
		}

		.message-icon.error {
			background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
		}

		.message-label {
			font-weight: 500;
			font-size: 12px;
			opacity: 0.8;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}

		.message-content {
			padding-left: 4px;
		}

		.priority-badge {
			display: inline-block;
			padding: 2px 6px;
			border-radius: 12px;
			font-size: 10px;
			font-weight: 500;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			margin-left: 6px;
		}

		.priority-badge.high {
			background: rgba(231, 76, 60, 0.15);
			color: #e74c3c;
			border: 1px solid rgba(231, 76, 60, 0.3);
		}

		.priority-badge.medium {
			background: rgba(243, 156, 18, 0.15);
			color: #f39c12;
			border: 1px solid rgba(243, 156, 18, 0.3);
		}

		.priority-badge.low {
			background: rgba(149, 165, 166, 0.15);
			color: #95a5a6;
			border: 1px solid rgba(149, 165, 166, 0.3);
		}

		.tool-input {
			margin-top: 4px;
			padding: 12px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			line-height: 1.4;
			white-space: pre-line;
		}

		.tool-input-label {
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
			font-weight: 500;
			margin-bottom: 6px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}

		.tool-input-content {
			color: var(--vscode-editor-foreground);
			opacity: 0.95;
		}

		.expand-btn {
			background: linear-gradient(135deg, rgba(64, 165, 255, 0.15) 0%, rgba(64, 165, 255, 0.1) 100%);
			border: 1px solid rgba(64, 165, 255, 0.3);
			color: #40a5ff;
			padding: 4px 8px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 11px;
			font-weight: 500;
			margin-left: 6px;
			display: inline-block;
			transition: all 0.2s ease;
		}

		.expand-btn:hover {
			background: linear-gradient(135deg, rgba(64, 165, 255, 0.25) 0%, rgba(64, 165, 255, 0.15) 100%);
			border-color: rgba(64, 165, 255, 0.5);
			transform: translateY(-1px);
		}

		.expanded-content {
			margin-top: 8px;
			padding: 12px;
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 6px;
			position: relative;
		}

		.expanded-content::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 3px;
			background: linear-gradient(180deg, #40a5ff 0%, #0078d4 100%);
			border-radius: 0 0 0 6px;
		}

		.expanded-content pre {
			margin: 0;
			white-space: pre-wrap;
			word-wrap: break-word;
		}

		.input-container {
			padding: 10px;
			border-top: 1px solid var(--vscode-panel-border);
			background-color: var(--vscode-panel-background);
			display: flex;
			gap: 10px;
			align-items: flex-end;
			position: relative;
		}

		.textarea-wrapper {
			flex: 1;
			background-color: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 6px;
			overflow: hidden;
		}

		.textarea-wrapper:focus-within {
			border-color: var(--vscode-focusBorder);
		}

		.input-field {
			width: 100%;
			background-color: transparent;
			color: var(--vscode-input-foreground);
			border: none;
			padding: 12px;
			outline: none;
			font-family: var(--vscode-editor-font-family);
			min-height: 20px;
			line-height: 1.4;
			overflow-y: hidden;
			resize: none;
		}

		.input-field:focus {
			border: none;
			outline: none;
		}

		.input-field::placeholder {
			color: var(--vscode-input-placeholderForeground);
			border: none;
			outline: none;
		}

		.input-controls {
			display: flex;
			align-items: center;
			justify-content: end;
			gap: 8px;
			padding: 2px 4px;
			border-top: 1px solid var(--vscode-panel-border);
			background-color: var(--vscode-input-background);
		}

		.tools-btn {
			background-color: rgba(128, 128, 128, 0.15);
			color: var(--vscode-foreground);
			border: none;
			padding: 3px 7px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 11px;
			font-weight: 500;
			transition: all 0.2s ease;
			opacity: 0.9;
			display: flex;
			align-items: center;
			gap: 4px;
		}

		.tools-btn:hover {
			background-color: rgba(128, 128, 128, 0.25);
			opacity: 1;
		}

		.at-btn {
			background-color: transparent;
			color: var(--vscode-foreground);
			border: none;
			padding: 4px 6px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 13px;
			font-weight: 600;
			transition: all 0.2s ease;
		}

		.at-btn:hover {
			background-color: var(--vscode-list-hoverBackground);
		}

		.image-btn {
			background-color: transparent;
			color: var(--vscode-foreground);
			border: none;
			padding: 4px;
			border-radius: 4px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 24px;
			height: 24px;
			transition: all 0.2s ease;
			padding-top: 6px;
		}

		.image-btn:hover {
			background-color: var(--vscode-list-hoverBackground);
		}

		.send-btn {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 3px 7px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 11px;
			font-weight: 500;
			transition: all 0.2s ease;
		}

		.send-btn div {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 2px;
		}

		.send-btn span {
			line-height: 1;
		}

		.send-btn:hover {
			background-color: var(--vscode-button-hoverBackground);
		}

		.send-btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.right-controls {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.beta-warning {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			text-align: center;
			font-style: italic;
			background-color: var(--vscode-panel-background);
			padding: 4px
		}

		.file-picker-modal {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background-color: rgba(0, 0, 0, 0.5);
			z-index: 1000;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.file-picker-content {
			background-color: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			width: 400px;
			max-height: 500px;
			display: flex;
			flex-direction: column;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		}

		.file-picker-header {
			padding: 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.file-picker-header span {
			font-weight: 500;
			color: var(--vscode-foreground);
		}

		.file-search-input {
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 6px 8px;
			border-radius: 3px;
			outline: none;
			font-size: 13px;
		}

		.file-search-input:focus {
			border-color: var(--vscode-focusBorder);
		}

		.file-list {
			max-height: 400px;
			overflow-y: auto;
			padding: 4px;
		}

		.file-item {
			display: flex;
			align-items: center;
			padding: 8px 12px;
			cursor: pointer;
			border-radius: 3px;
			font-size: 13px;
			gap: 8px;
		}

		.file-item:hover {
			background-color: var(--vscode-list-hoverBackground);
		}

		.file-item.selected {
			background-color: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}

		.file-icon {
			font-size: 16px;
			flex-shrink: 0;
		}

		.file-info {
			flex: 1;
			display: flex;
			flex-direction: column;
		}

		.file-name {
			font-weight: 500;
		}

		.file-path {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
		}

		.file-thumbnail {
			width: 32px;
			height: 32px;
			border-radius: 4px;
			overflow: hidden;
			background-color: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			display: flex;
			align-items: center;
			justify-content: center;
			flex-shrink: 0;
		}

		.thumbnail-img {
			max-width: 100%;
			max-height: 100%;
			object-fit: cover;
		}

		.tools-modal {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background-color: rgba(0, 0, 0, 0.5);
			z-index: 1000;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.tools-modal-content {
			background-color: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			width: 450px;
			max-height: 600px;
			display: flex;
			flex-direction: column;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		}

		.tools-modal-header {
			padding: 12px 16px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.tools-modal-header span {
			font-weight: 600;
			color: var(--vscode-foreground);
		}

		.tools-close-btn {
			background: none;
			border: none;
			color: var(--vscode-foreground);
			cursor: pointer;
			font-size: 16px;
			padding: 4px;
		}

		.tools-beta-warning {
			padding: 12px 16px;
			background-color: var(--vscode-notifications-warningBackground);
			color: var(--vscode-notifications-warningForeground);
			font-size: 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		.tools-list {
			padding: 16px;
			max-height: 400px;
			overflow-y: auto;
		}

		.tool-item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		.tool-item:last-child {
			border-bottom: none;
		}

		.tool-item input[type="checkbox"] {
			margin: 0;
		}

		.tool-item label {
			color: var(--vscode-foreground);
			font-size: 13px;
			cursor: pointer;
			flex: 1;
		}

		.tool-item input[type="checkbox"]:disabled + label {
			opacity: 0.7;
		}

		.status {
			padding: 8px 12px;
			background: linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%);
			color: #e1e1e1;
			font-size: 12px;
			border-top: 1px solid var(--vscode-panel-border);
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 500;
		}

		.status-indicator {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			flex-shrink: 0;
		}

		.status.ready .status-indicator {
			background-color: #00d26a;
			box-shadow: 0 0 6px rgba(0, 210, 106, 0.5);
		}

		.status.processing .status-indicator {
			background-color: #ff9500;
			box-shadow: 0 0 6px rgba(255, 149, 0, 0.5);
			animation: pulse 1.5s ease-in-out infinite;
		}

		.status.error .status-indicator {
			background-color: #ff453a;
			box-shadow: 0 0 6px rgba(255, 69, 58, 0.5);
		}

		@keyframes pulse {
			0%, 100% { opacity: 1; transform: scale(1); }
			50% { opacity: 0.7; transform: scale(1.1); }
		}

		.status-text {
			flex: 1;
		}

		pre {
			white-space: pre-wrap;
			word-wrap: break-word;
			margin: 0;
		}

		.session-badge {
			margin-left: 16px;
			background-color: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			padding: 4px 8px;
			border-radius: 12px;
			font-size: 11px;
			font-weight: 500;
			display: flex;
			align-items: center;
			gap: 4px;
			transition: background-color 0.2s, transform 0.1s;
		}

		.session-badge:hover {
			background-color: var(--vscode-button-hoverBackground);
			transform: scale(1.02);
		}

		.session-icon {
			font-size: 10px;
		}

		.session-label {
			opacity: 0.8;
			font-size: 10px;
		}

		.session-status {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			padding: 2px 6px;
			border-radius: 4px;
			background-color: var(--vscode-badge-background);
			border: 1px solid var(--vscode-panel-border);
		}

		.session-status.active {
			color: var(--vscode-terminal-ansiGreen);
			background-color: rgba(0, 210, 106, 0.1);
			border-color: var(--vscode-terminal-ansiGreen);
		}

		/* Markdown content styles */
		.message h1, .message h2, .message h3, .message h4 {
			margin: 0.8em 0 0.4em 0;
			font-weight: 600;
			line-height: 1.3;
		}

		.message h1 {
			font-size: 1.5em;
			border-bottom: 2px solid var(--vscode-panel-border);
			padding-bottom: 0.3em;
		}

		.message h2 {
			font-size: 1.3em;
			border-bottom: 1px solid var(--vscode-panel-border);
			padding-bottom: 0.2em;
		}

		.message h3 {
			font-size: 1.1em;
		}

		.message h4 {
			font-size: 1.05em;
		}

		.message strong {
			font-weight: 600;
			color: var(--vscode-terminal-ansiBrightWhite);
		}

		.message em {
			font-style: italic;
		}

		.message ul, .message ol {
			margin: 0.6em 0;
			padding-left: 1.5em;
		}

		.message li {
			margin: 0.3em 0;
			line-height: 1.4;
		}

		.message ul li {
			list-style-type: disc;
		}

		.message ol li {
			list-style-type: decimal;
		}

		.message p {
			margin: 0.5em 0;
			line-height: 1.6;
		}

		.message p:first-child {
			margin-top: 0;
		}

		.message p:last-child {
			margin-bottom: 0;
		}

		.message br {
			line-height: 1.2;
		}

		.restore-container {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 10px
		}

		.restore-btn {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 4px 10px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
		}

		.restore-btn.dark {
			background-color: #2d2d30;
			color: #999999;
		}

		.restore-btn:hover {
			background-color: var(--vscode-button-hoverBackground);
		}

		.restore-btn.dark:hover {
			background-color: #3e3e42;
		}

		.restore-date {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			opacity: 0.8;
		}

		.conversation-history {
			position: absolute;
			top: 60px;
			left: 0;
			right: 0;
			bottom: 60px;
			background-color: var(--vscode-editor-background);
			border: 1px solid var(--vscode-widget-border);
			z-index: 1000;
		}

		.conversation-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 12px 16px;
			border-bottom: 1px solid var(--vscode-widget-border);
		}

		.conversation-header h3 {
			margin: 0;
			font-size: 16px;
		}

		.conversation-list {
			padding: 8px;
			overflow-y: auto;
			height: calc(100% - 60px);
		}

		.conversation-item {
			padding: 12px;
			margin: 4px 0;
			border: 1px solid var(--vscode-widget-border);
			border-radius: 6px;
			cursor: pointer;
			background-color: var(--vscode-list-inactiveSelectionBackground);
		}

		.conversation-item:hover {
			background-color: var(--vscode-list-hoverBackground);
		}

		.conversation-title {
			font-weight: 500;
			margin-bottom: 4px;
		}

		.conversation-meta {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 4px;
		}

		.conversation-preview {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			opacity: 0.8;
		}
	</style>
</head>
<body>
	<div class="header">
		<div style="display: flex; align-items: center;">
			<h2>Claude Code Chat</h2>
			<!-- <div id="sessionInfo" class="session-badge" style="display: none;">
				<span class="session-icon">💬</span>
				<span id="sessionId">-</span>
				<span class="session-label">session</span>
			</div> -->
		</div>
		<div style="display: flex; gap: 8px; align-items: center;">
			<div id="sessionStatus" class="session-status" style="display: none;">No session</div>
			<button class="btn outlined" id="historyBtn" onclick="toggleConversationHistory()" style="display: none;">📚 History</button>
			<button class="btn primary" id="newSessionBtn" onclick="newSession()" style="display: none;">New Chat</button>
		</div>
	</div>
	
	<div id="conversationHistory" class="conversation-history" style="display: none;">
		<div class="conversation-header">
			<h3>Conversation History</h3>
			<button class="btn" onclick="toggleConversationHistory()">✕ Close</button>
		</div>
		<div id="conversationList" class="conversation-list">
			<!-- Conversations will be loaded here -->
		</div>
	</div>

	<div class="chat-container" id="chatContainer">
		<div class="messages" id="messages"></div>
		<div class="input-container" id="inputContainer">
			<div class="textarea-wrapper">
				<textarea class="input-field" id="messageInput" placeholder="Type your message to Claude Code..." rows="1"></textarea>
				<div class="input-controls">
					<button class="tools-btn" onclick="showToolsModal()" title="Configure tools">
						Tools: All
						<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
							<path d="M1 2.5l3 3 3-3"></path>
						</svg>
					</button>
						<button class="at-btn" onclick="showFilePicker()" title="Reference files">@</button>
						<button class="image-btn" id="imageBtn" onclick="selectImage()" title="Attach images">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 16 16"
					width="14"
					height="16"
					>
					<g fill="currentColor">
						<path d="M6.002 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0"></path>
						<path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2zm13 1a.5.5 0 0 1 .5.5v6l-3.775-1.947a.5.5 0 0 0-.577.093l-3.71 3.71l-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12v.54L1 12.5v-9a.5.5 0 0 1 .5-.5z"></path>
					</g>
					</svg>
					</button>
					<button class="send-btn" id="sendBtn" onclick="sendMessage()">
					<div>
					<span>Send </span>
					   <svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						width="11"
						height="11"
						>
						<path
							fill="currentColor"
							d="M20 4v9a4 4 0 0 1-4 4H6.914l2.5 2.5L8 20.914L3.086 16L8 11.086L9.414 12.5l-2.5 2.5H16a2 2 0 0 0 2-2V4z"
						></path>
						</svg>
						</div>
					</button>
				</div>
			</div>
		</div>
	</div>
	
	<div class="status ready" id="status">
		<div class="status-indicator"></div>
		<div class="status-text" id="statusText">Initializing...</div>
		<button class="btn stop" id="stopBtn" onclick="stopRequest()" style="display: none;">
			<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
				<path d="M6 6h12v12H6z"/>
			</svg>
			Stop
		</button>
	</div>

			<div class="beta-warning">
			In Beta. All Claude Code tools are allowed. Use at your own risk.
		</div>

	<!-- File picker modal -->
	<div id="filePickerModal" class="file-picker-modal" style="display: none;">
		<div class="file-picker-content">
			<div class="file-picker-header">
				<span>Select File</span>
				<input type="text" id="fileSearchInput" placeholder="Search files..." class="file-search-input">
			</div>
			<div id="fileList" class="file-list">
				<!-- Files will be loaded here -->
			</div>
		</div>
	</div>

	<!-- Tools modal -->
	<div id="toolsModal" class="tools-modal" style="display: none;">
		<div class="tools-modal-content">
			<div class="tools-modal-header">
				<span>Claude Code Tools</span>
				<button class="tools-close-btn" onclick="hideToolsModal()">✕</button>
			</div>
			<div class="tools-beta-warning">
				In Beta: All tools are enabled by default. Use at your own risk.
			</div>
			<div id="toolsList" class="tools-list">
				<div class="tool-item">
					<input type="checkbox" id="tool-bash" checked disabled>
					<label for="tool-bash">Bash - Execute shell commands</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-read" checked disabled>
					<label for="tool-read">Read - Read file contents</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-edit" checked disabled>
					<label for="tool-edit">Edit - Modify files</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-write" checked disabled>
					<label for="tool-write">Write - Create new files</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-glob" checked disabled>
					<label for="tool-glob">Glob - Find files by pattern</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-grep" checked disabled>
					<label for="tool-grep">Grep - Search file contents</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-ls" checked disabled>
					<label for="tool-ls">LS - List directory contents</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-multiedit" checked disabled>
					<label for="tool-multiedit">MultiEdit - Edit multiple files</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-websearch" checked disabled>
					<label for="tool-websearch">WebSearch - Search the web</label>
				</div>
				<div class="tool-item">
					<input type="checkbox" id="tool-webfetch" checked disabled>
					<label for="tool-webfetch">WebFetch - Fetch web content</label>
				</div>
			</div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		const messagesDiv = document.getElementById('messages');
		const messageInput = document.getElementById('messageInput');
		const sendBtn = document.getElementById('sendBtn');
		const statusDiv = document.getElementById('status');
		const statusTextDiv = document.getElementById('statusText');
		const filePickerModal = document.getElementById('filePickerModal');
		const fileSearchInput = document.getElementById('fileSearchInput');
		const fileList = document.getElementById('fileList');
		const imageBtn = document.getElementById('imageBtn');

		let isProcessRunning = false;
		let filteredFiles = [];
		let selectedFileIndex = -1;

		function addMessage(content, type = 'claude') {
			const messageDiv = document.createElement('div');
			messageDiv.className = \`message \${type}\`;
			
			// Add header for main message types (excluding system)
			if (type === 'user' || type === 'claude' || type === 'error') {
				const headerDiv = document.createElement('div');
				headerDiv.className = 'message-header';
				
				const iconDiv = document.createElement('div');
				iconDiv.className = \`message-icon \${type}\`;
				
				const labelDiv = document.createElement('div');
				labelDiv.className = 'message-label';
				
				// Set icon and label based on type
				switch(type) {
					case 'user':
						iconDiv.textContent = '👤';
						labelDiv.textContent = 'You';
						break;
					case 'claude':
						iconDiv.textContent = '🤖';
						labelDiv.textContent = 'Claude';
						break;
					case 'error':
						iconDiv.textContent = '⚠️';
						labelDiv.textContent = 'Error';
						break;
				}
				
				// Add copy button
				const copyBtn = document.createElement('button');
				copyBtn.className = 'copy-btn';
				copyBtn.title = 'Copy message';
				copyBtn.onclick = () => copyMessageContent(messageDiv);
				copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
				
				headerDiv.appendChild(iconDiv);
				headerDiv.appendChild(labelDiv);
				headerDiv.appendChild(copyBtn);
				messageDiv.appendChild(headerDiv);
			}
			
			// Add content
			const contentDiv = document.createElement('div');
			contentDiv.className = 'message-content';
			
			if(type == 'user' || type === 'claude' || type === 'thinking'){
				contentDiv.innerHTML = content;
			} else {
				const preElement = document.createElement('pre');
				preElement.textContent = content;
				contentDiv.appendChild(preElement);
			}
			
			messageDiv.appendChild(contentDiv);
			messagesDiv.appendChild(messageDiv);
			messagesDiv.scrollTop = messagesDiv.scrollHeight;
		}


		function addToolUseMessage(data) {
			const messageDiv = document.createElement('div');
			messageDiv.className = 'message tool';
			
			// Create modern header with icon
			const headerDiv = document.createElement('div');
			headerDiv.className = 'tool-header';
			
			const iconDiv = document.createElement('div');
			iconDiv.className = 'tool-icon';
			iconDiv.textContent = '🔧';
			
			const toolInfoElement = document.createElement('div');
			toolInfoElement.className = 'tool-info';
			toolInfoElement.textContent = data.toolInfo.replace('🔧 Executing: ', '');
			
			headerDiv.appendChild(iconDiv);
			headerDiv.appendChild(toolInfoElement);
			messageDiv.appendChild(headerDiv);
			
			if (data.rawInput) {
				const inputElement = document.createElement('div');
				inputElement.className = 'tool-input';
				
				const contentDiv = document.createElement('div');
				contentDiv.className = 'tool-input-content';
				
				// Handle TodoWrite specially or format raw input
				if (data.toolName === 'TodoWrite' && data.rawInput.todos) {
					let todoHtml = 'Todo List Update:';
					for (const todo of data.rawInput.todos) {
						const status = todo.status === 'completed' ? '✅' :
							todo.status === 'in_progress' ? '🔄' : '⏳';
						todoHtml += '\\n' + status + ' ' + todo.content + ' <span class="priority-badge ' + todo.priority + '">' + todo.priority + '</span>';
					}
					contentDiv.innerHTML = todoHtml;
				} else {
					// Format raw input with expandable content for long values
					contentDiv.innerHTML = formatToolInputUI(data.rawInput);
				}
				
				inputElement.appendChild(contentDiv);
				messageDiv.appendChild(inputElement);
			} else if (data.toolInput) {
				// Fallback for pre-formatted input
				const inputElement = document.createElement('div');
				inputElement.className = 'tool-input';
				
				const labelDiv = document.createElement('div');
				labelDiv.className = 'tool-input-label';
				labelDiv.textContent = 'INPUT';
				inputElement.appendChild(labelDiv);
				
				const contentDiv = document.createElement('div');
				contentDiv.className = 'tool-input-content';
				contentDiv.textContent = data.toolInput;
				inputElement.appendChild(contentDiv);
				messageDiv.appendChild(inputElement);
			}
			
			messagesDiv.appendChild(messageDiv);
			messagesDiv.scrollTop = messagesDiv.scrollHeight;
		}

		function createExpandableInput(toolInput, rawInput) {
			try {
				let html = toolInput.replace(/\\[expand\\]/g, '<span class="expand-btn" onclick="toggleExpand(this)">expand</span>');
				
				// Store raw input data for expansion
				if (rawInput && typeof rawInput === 'object') {
					let btnIndex = 0;
					html = html.replace(/<span class="expand-btn"[^>]*>expand<\\/span>/g, (match) => {
						const keys = Object.keys(rawInput);
						const key = keys[btnIndex] || '';
						const value = rawInput[key] || '';
						const valueStr = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
						const escapedValue = valueStr.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
						btnIndex++;
						return \`<span class="expand-btn" data-key="\${key}" data-value="\${escapedValue}" onclick="toggleExpand(this)">expand</span>\`;
					});
				}
				
				return html;
			} catch (error) {
				console.error('Error creating expandable input:', error);
				return toolInput;
			}
		}

		function toggleExpand(element) {
			try {
				const value = element.getAttribute('data-value');
				
				if (element.classList.contains('expanded')) {
					// Collapse
					element.textContent = 'expand';
					element.classList.remove('expanded');
					
					const expandedContent = element.parentNode.querySelector('.expanded-content');
					if (expandedContent) {
						expandedContent.remove();
					}
				} else {
					// Expand
					element.textContent = 'collapse';
					element.classList.add('expanded');
					
					const expandedDiv = document.createElement('div');
					expandedDiv.className = 'expanded-content';
					const preElement = document.createElement('pre');
					preElement.textContent = value;
					expandedDiv.appendChild(preElement);
					element.parentNode.appendChild(expandedDiv);
				}
			} catch (error) {
				console.error('Error toggling expand:', error);
			}
		}

		function addToolResultMessage(data) {
			const messageDiv = document.createElement('div');
			messageDiv.className = data.isError ? 'message error' : 'message tool-result';
			
			// Create header
			const headerDiv = document.createElement('div');
			headerDiv.className = 'message-header';
			
			const iconDiv = document.createElement('div');
			iconDiv.className = data.isError ? 'message-icon error' : 'message-icon';
			iconDiv.style.background = data.isError ? 
				'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)' : 
				'linear-gradient(135deg, #1cc08c 0%, #16a974 100%)';
			iconDiv.textContent = data.isError ? '❌' : '✅';
			
			const labelDiv = document.createElement('div');
			labelDiv.className = 'message-label';
			labelDiv.textContent = data.isError ? 'Error' : 'Result';
			
			headerDiv.appendChild(iconDiv);
			headerDiv.appendChild(labelDiv);
			messageDiv.appendChild(headerDiv);
			
			// Add content
			const contentDiv = document.createElement('div');
			contentDiv.className = 'message-content';
			
			// Check if it's a tool result and truncate appropriately
			let content = data.content;
			if (content.length > 200 && !data.isError) {
				const truncated = content.substring(0, 197) + '...';
				const escapedValue = content.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
				const preElement = document.createElement('pre');
				preElement.innerHTML = truncated + ' <span class="expand-btn" data-value="' + escapedValue + '" onclick="toggleExpand(this)">expand</span>';
				contentDiv.appendChild(preElement);
			} else {
				const preElement = document.createElement('pre');
				preElement.textContent = content;
				contentDiv.appendChild(preElement);
			}
			
			messageDiv.appendChild(contentDiv);
			messagesDiv.appendChild(messageDiv);
			messagesDiv.scrollTop = messagesDiv.scrollHeight;
		}

		function formatToolInputUI(input) {
			if (!input || typeof input !== 'object') {
				const str = String(input);
				if (str.length > 100) {
					return str.substring(0, 97) + '... <span class="expand-btn" data-value="' + str.replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '" onclick="toggleExpand(this)">expand</span>';
				}
				return str;
			}

			let result = '';
			let isFirst = true;
			for (const [key, value] of Object.entries(input)) {
				const valueStr = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
				
				if (!isFirst) result += '\\n';
				isFirst = false;
				
				if (valueStr.length > 100) {
					const truncated = valueStr.substring(0, 97) + '...';
					const escapedValue = valueStr.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
					result += '<strong>' + key + ':</strong> ' + truncated + ' <span class="expand-btn" data-key="' + key + '" data-value="' + escapedValue + '" onclick="toggleExpand(this)">expand</span>';
				} else {
					result += '<strong>' + key + ':</strong> ' + valueStr;
				}
			}
			return result;
		}

		function sendMessage() {
			const text = messageInput.value.trim();
			if (text) {
				vscode.postMessage({
					type: 'sendMessage',
					text: text
				});
				
				messageInput.value = '';
			}
		}


		let totalCost = 0;
		let totalTokensInput = 0;
		let totalTokensOutput = 0;
		let requestCount = 0;
		let isProcessing = false;
		let requestStartTime = null;
		let requestTimer = null;

		function updateStatus(text, state = 'ready') {
			statusTextDiv.textContent = text;
			statusDiv.className = \`status \${state}\`;
		}

		function updateStatusWithTotals() {
			if (isProcessing) {
				// While processing, show tokens and elapsed time
				const totalTokens = totalTokensInput + totalTokensOutput;
				const tokensStr = totalTokens > 0 ? 
					\`\${totalTokens.toLocaleString()} tokens\` : '0 tokens';
				
				let elapsedStr = '';
				if (requestStartTime) {
					const elapsedSeconds = Math.floor((Date.now() - requestStartTime) / 1000);
					elapsedStr = \` • \${elapsedSeconds}s\`;
				}
				
				const statusText = \`Processing • \${tokensStr}\${elapsedStr}\`;
				updateStatus(statusText, 'processing');
			} else {
				// When ready, show full info
				const costStr = totalCost > 0 ? \`$\${totalCost.toFixed(4)}\` : '$0.00';
				const totalTokens = totalTokensInput + totalTokensOutput;
				const tokensStr = totalTokens > 0 ? 
					\`\${totalTokens.toLocaleString()} tokens\` : '0 tokens';
				const requestStr = requestCount > 0 ? \`\${requestCount} requests\` : '';
				
				const statusText = \`Ready • \${costStr} • \${tokensStr}\${requestStr ? \` • \${requestStr}\` : ''}\`;
				updateStatus(statusText, 'ready');
			}
		}

		function startRequestTimer() {
			requestStartTime = Date.now();
			// Update status every 100ms for smooth real-time display
			requestTimer = setInterval(() => {
				if (isProcessing) {
					updateStatusWithTotals();
				}
			}, 100);
		}

		function stopRequestTimer() {
			if (requestTimer) {
				clearInterval(requestTimer);
				requestTimer = null;
			}
			requestStartTime = null;
		}

		// Auto-resize textarea
		function adjustTextareaHeight() {
			// Reset height to calculate new height
			messageInput.style.height = 'auto';
			
			// Get computed styles
			const computedStyle = getComputedStyle(messageInput);
			const lineHeight = parseFloat(computedStyle.lineHeight);
			const paddingTop = parseFloat(computedStyle.paddingTop);
			const paddingBottom = parseFloat(computedStyle.paddingBottom);
			const borderTop = parseFloat(computedStyle.borderTopWidth);
			const borderBottom = parseFloat(computedStyle.borderBottomWidth);
			
			// Calculate heights
			const scrollHeight = messageInput.scrollHeight;
			const maxRows = 5;
			const minHeight = lineHeight + paddingTop + paddingBottom + borderTop + borderBottom;
			const maxHeight = (lineHeight * maxRows) + paddingTop + paddingBottom + borderTop + borderBottom;
			
			// Set height
			if (scrollHeight <= maxHeight) {
				messageInput.style.height = Math.max(scrollHeight, minHeight) + 'px';
				messageInput.style.overflowY = 'hidden';
			} else {
				messageInput.style.height = maxHeight + 'px';
				messageInput.style.overflowY = 'auto';
			}
		}

		messageInput.addEventListener('input', adjustTextareaHeight);
		
		messageInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			} else if (e.key === '@' && !e.ctrlKey && !e.metaKey) {
				// Don't prevent default, let @ be typed first
				setTimeout(() => {
					showFilePicker();
				}, 0);
			} else if (e.key === 'Escape' && filePickerModal.style.display === 'flex') {
				e.preventDefault();
				hideFilePicker();
			}
		});

		// Initialize textarea height
		adjustTextareaHeight();

		// File picker event listeners
		fileSearchInput.addEventListener('input', (e) => {
			filterFiles(e.target.value);
		});

		fileSearchInput.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selectedFileIndex = Math.min(selectedFileIndex + 1, filteredFiles.length - 1);
				renderFileList();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				selectedFileIndex = Math.max(selectedFileIndex - 1, -1);
				renderFileList();
			} else if (e.key === 'Enter' && selectedFileIndex >= 0) {
				e.preventDefault();
				selectFile(filteredFiles[selectedFileIndex]);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				hideFilePicker();
			}
		});

		// Close modal when clicking outside
		filePickerModal.addEventListener('click', (e) => {
			if (e.target === filePickerModal) {
				hideFilePicker();
			}
		});

		// Tools modal functions
		function showToolsModal() {
			document.getElementById('toolsModal').style.display = 'flex';
		}

		function hideToolsModal() {
			document.getElementById('toolsModal').style.display = 'none';
		}

		// Close tools modal when clicking outside
		document.getElementById('toolsModal').addEventListener('click', (e) => {
			if (e.target === document.getElementById('toolsModal')) {
				hideToolsModal();
			}
		});

		// Stop button functions
		function showStopButton() {
			document.getElementById('stopBtn').style.display = 'flex';
		}

		function hideStopButton() {
			document.getElementById('stopBtn').style.display = 'none';
		}

		function stopRequest() {
			vscode.postMessage({
				type: 'stopRequest'
			});
			hideStopButton();
		}

		// Disable/enable buttons during processing
		function disableButtons() {
			const sendBtn = document.getElementById('sendBtn');
			if (sendBtn) sendBtn.disabled = true;
		}

		function enableButtons() {
			const sendBtn = document.getElementById('sendBtn');
			if (sendBtn) sendBtn.disabled = false;
		}

		// Copy message content function
		function copyMessageContent(messageDiv) {
			const contentDiv = messageDiv.querySelector('.message-content');
			if (contentDiv) {
				// Get text content, preserving line breaks
				const text = contentDiv.innerText || contentDiv.textContent;
				
				// Copy to clipboard
				navigator.clipboard.writeText(text).then(() => {
					// Show brief feedback
					const copyBtn = messageDiv.querySelector('.copy-btn');
					const originalHtml = copyBtn.innerHTML;
					copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
					copyBtn.style.color = '#4caf50';
					
					setTimeout(() => {
						copyBtn.innerHTML = originalHtml;
						copyBtn.style.color = '';
					}, 1000);
				}).catch(err => {
					console.error('Failed to copy message:', err);
				});
			}
		}

		window.addEventListener('message', event => {
			const message = event.data;
			
			switch (message.type) {
				case 'ready':
					addMessage(message.data, 'system');
					updateStatusWithTotals();
					break;
					
				case 'output':
					if (message.data.trim()) {
						addMessage(parseSimpleMarkdown(message.data), 'claude');
					}
					updateStatusWithTotals();
					break;
					
				case 'userInput':
					if (message.data.trim()) {
						addMessage(parseSimpleMarkdown(message.data), 'user');
					}
					break;
					
				case 'loading':
					addMessage(message.data, 'system');
					updateStatusWithTotals();
					break;
					
				case 'setProcessing':
					isProcessing = message.data;
					if (isProcessing) {
						startRequestTimer();
						showStopButton();
						disableButtons();
					} else {
						stopRequestTimer();
						hideStopButton();
						enableButtons();
					}
					updateStatusWithTotals();
					break;
					
				case 'clearLoading':
					// Remove the last loading message
					const messages = messagesDiv.children;
					if (messages.length > 0) {
						const lastMessage = messages[messages.length - 1];
						if (lastMessage.classList.contains('system')) {
							lastMessage.remove();
						}
					}
					updateStatusWithTotals();
					break;
					
				case 'error':
					if (message.data.trim()) {
						addMessage(message.data, 'error');
					}
					updateStatusWithTotals();
					break;
					
				case 'toolUse':
					if (typeof message.data === 'object') {
						addToolUseMessage(message.data);
					} else if (message.data.trim()) {
						addMessage(message.data, 'tool');
					}
					break;
					
				case 'toolResult':
					if (message.data.content.trim()) {
						// Don't show result for TodoWrite tool (it's redundant with the tool execution display)
						const isTodoWrite = message.data.content.includes('Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable')
						
						if (!isTodoWrite) {
							addToolResultMessage(message.data);
						}
					}
					break;
					
				case 'thinking':
					if (message.data.trim()) {
						addMessage('💭 Thinking...' + parseSimpleMarkdown(message.data), 'thinking');
					}
					break;
					
				case 'sessionInfo':
					console.log('Session info:', message.data);
					if (message.data.sessionId) {
						showSessionInfo(message.data.sessionId);
						// Show detailed session information
						const sessionDetails = [
							\`🆔 Session ID: \${message.data.sessionId}\`,
							\`🔧 Tools Available: \${message.data.tools.length}\`,
							\`🖥️ MCP Servers: \${message.data.mcpServers ? message.data.mcpServers.length : 0}\`
						];
						//addMessage(sessionDetails.join('\\n'), 'system');
					}
					break;
					
				case 'updateTokens':
					console.log('Tokens updated in real-time:', message.data);
					// Update token totals in real-time
					totalTokensInput = message.data.totalTokensInput || 0;
					totalTokensOutput = message.data.totalTokensOutput || 0;
					
					// Update status bar immediately
					updateStatusWithTotals();
					
					// Show detailed token breakdown for current message
					const currentTotal = (message.data.currentInputTokens || 0) + (message.data.currentOutputTokens || 0);
					if (currentTotal > 0) {
						let tokenBreakdown = \`📊 Tokens: \${currentTotal.toLocaleString()}\`;
						
						if (message.data.cacheCreationTokens || message.data.cacheReadTokens) {
							const cacheInfo = [];
							if (message.data.cacheCreationTokens) cacheInfo.push(\`\${message.data.cacheCreationTokens.toLocaleString()} cache created\`);
							if (message.data.cacheReadTokens) cacheInfo.push(\`\${message.data.cacheReadTokens.toLocaleString()} cache read\`);
							tokenBreakdown += \` • \${cacheInfo.join(' • ')}\`;
						}
						
						addMessage(tokenBreakdown, 'system');
					}
					break;
					
				case 'updateTotals':
					console.log('Totals updated:', message.data);
					console.log('Cost data received:', {
						totalCost: message.data.totalCost,
						currentCost: message.data.currentCost,
						previousTotalCost: totalCost
					});
					// Update local tracking variables
					totalCost = message.data.totalCost || 0;
					totalTokensInput = message.data.totalTokensInput || 0;
					totalTokensOutput = message.data.totalTokensOutput || 0;
					requestCount = message.data.requestCount || 0;
					
					// Update status bar with new totals
					updateStatusWithTotals();
					
					// Show current request info if available
					if (message.data.currentCost || message.data.currentDuration) {
						const currentCostStr = message.data.currentCost ? \`$\${message.data.currentCost.toFixed(4)}\` : 'N/A';
						const currentDurationStr = message.data.currentDuration ? \`\${message.data.currentDuration}ms\` : 'N/A';
						addMessage(\`Request completed - Cost: \${currentCostStr}, Duration: \${currentDurationStr}\`, 'system');
					}
					break;
					
				case 'sessionResumed':
					console.log('Session resumed:', message.data);
					showSessionInfo(message.data.sessionId);
					addMessage(\`📝 Resumed previous session\\n🆔 Session ID: \${message.data.sessionId}\\n💡 Your conversation history is preserved\`, 'system');
					break;
					
				case 'sessionCleared':
					console.log('Session cleared');
					// Clear all messages from UI
					messagesDiv.innerHTML = '';
					hideSessionInfo();
					addMessage('🆕 Started new session', 'system');
					// Reset totals
					totalCost = 0;
					totalTokensInput = 0;
					totalTokensOutput = 0;
					requestCount = 0;
					updateStatusWithTotals();
					break;
					
				case 'loginRequired':
					addMessage('🔐 Login Required\\n\\nYour Claude API key is invalid or expired.\\nA terminal has been opened - please run the login process there.\\n\\nAfter logging in, come back to this chat to continue.', 'error');
					updateStatus('Login Required', 'error');
					break;
					
				case 'showRestoreOption':
					console.log('Show restore option:', message.data);
					showRestoreContainer(message.data);
					break;
					
				case 'restoreProgress':
					addMessage('🔄 ' + message.data, 'system');
					break;
					
				case 'restoreSuccess':
					//hideRestoreContainer(message.data.commitSha);
					addMessage('✅ ' + message.data.message, 'system');
					break;
					
				case 'restoreError':
					addMessage('❌ ' + message.data, 'error');
					break;
					
				case 'workspaceFiles':
					filteredFiles = message.data;
					selectedFileIndex = -1;
					renderFileList();
					break;
					
				case 'imagePath':
					// Add the image path to the textarea
					const currentText = messageInput.value;
					const pathIndicator = \`@\${message.path} \`;
					messageInput.value = currentText + pathIndicator;
					messageInput.focus();
					adjustTextareaHeight();
					break;
					
				case 'conversationList':
					displayConversationList(message.data);
					break;
			}
		});
		
		// Session management functions
		function newSession() {
			vscode.postMessage({
				type: 'newSession'
			});
		}

		function restoreToCommit(commitSha) {
			console.log('Restore button clicked for commit:', commitSha);
			vscode.postMessage({
				type: 'restoreCommit',
				commitSha: commitSha
			});
		}

		function showRestoreContainer(data) {
			const restoreContainer = document.createElement('div');
			restoreContainer.className = 'restore-container';
			restoreContainer.id = \`restore-\${data.sha}\`;
			
			const timeAgo = new Date(data.timestamp).toLocaleTimeString();
			const shortSha = data.sha ? data.sha.substring(0, 8) : 'unknown';
			
			restoreContainer.innerHTML = \`
				<button class="restore-btn dark" onclick="restoreToCommit('\${data.sha}')">
					Restore checkpoint
				</button>
				<span class="restore-date">\${timeAgo}</span>
			\`;
			
			messagesDiv.appendChild(restoreContainer);
			messagesDiv.scrollTop = messagesDiv.scrollHeight;
		}

		function hideRestoreContainer(commitSha) {
			const container = document.getElementById(\`restore-\${commitSha}\`);
			if (container) {
				container.remove();
			}
		}
		
		function showSessionInfo(sessionId) {
			// const sessionInfo = document.getElementById('sessionInfo');
			// const sessionIdSpan = document.getElementById('sessionId');
			const sessionStatus = document.getElementById('sessionStatus');
			const newSessionBtn = document.getElementById('newSessionBtn');
			const historyBtn = document.getElementById('historyBtn');
			
			if (sessionStatus && newSessionBtn) {
				// sessionIdSpan.textContent = sessionId.substring(0, 8);
				// sessionIdSpan.title = \`Full session ID: \${sessionId} (click to copy)\`;
				// sessionIdSpan.style.cursor = 'pointer';
				// sessionIdSpan.onclick = () => copySessionId(sessionId);
				// sessionInfo.style.display = 'flex';
				sessionStatus.style.display = 'none';
				newSessionBtn.style.display = 'block';
				if (historyBtn) historyBtn.style.display = 'block';
			}
		}
		
		function copySessionId(sessionId) {
			navigator.clipboard.writeText(sessionId).then(() => {
				// Show temporary feedback
				const sessionIdSpan = document.getElementById('sessionId');
				if (sessionIdSpan) {
					const originalText = sessionIdSpan.textContent;
					sessionIdSpan.textContent = 'Copied!';
					setTimeout(() => {
						sessionIdSpan.textContent = originalText;
					}, 1000);
				}
			}).catch(err => {
				console.error('Failed to copy session ID:', err);
			});
		}
		
		function hideSessionInfo() {
			// const sessionInfo = document.getElementById('sessionInfo');
			const sessionStatus = document.getElementById('sessionStatus');
			const newSessionBtn = document.getElementById('newSessionBtn');
			const historyBtn = document.getElementById('historyBtn');
			
			if (sessionStatus && newSessionBtn) {
				// sessionInfo.style.display = 'none';
				sessionStatus.style.display = 'none';
				newSessionBtn.style.display = 'none';
				// Keep history button visible - don't hide it
				if (historyBtn) historyBtn.style.display = 'block';
			}
		}

		updateStatus('Initializing...', 'disconnected');
		

		function parseSimpleMarkdown(markdown) {
			const lines = markdown.split('\\n');
			let html = '';
			let inUnorderedList = false;
			let inOrderedList = false;

			for (let line of lines) {
				line = line.trim();

				// Bold
				line = line.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');

				// Italic
				line = line.replace(/(?<!\\*)\\*(?!\\*)(.*?)\\*(?!\\*)/g, '<em>$1</em>');
				line = line.replace(/_(.*?)_/g, '<em>$1</em>');

				// Headers
				if (/^####\\s+/.test(line)) {
				html += '<h4>' + line.replace(/^####\\s+/, '') + '</h4>';
				continue;
				} else if (/^###\\s+/.test(line)) {
				html += '<h3>' + line.replace(/^###\\s+/, '') + '</h3>';
				continue;
				} else if (/^##\\s+/.test(line)) {
				html += '<h2>' + line.replace(/^##\\s+/, '') + '</h2>';
				continue;
				} else if (/^#\\s+/.test(line)) {
				html += '<h1>' + line.replace(/^#\\s+/, '') + '</h1>';
				continue;
				}

				// Ordered list
				if (/^\\d+\\.\\s+/.test(line)) {
				if (!inOrderedList) {
					html += '<ol>';
					inOrderedList = true;
				}
				const item = line.replace(/^\\d+\\.\\s+/, '');
				html += '<li>' + item + '</li>';
				continue;
				}

				// Unordered list
				if (line.startsWith('- ')) {
				if (!inUnorderedList) {
					html += '<ul>';
					inUnorderedList = true;
				}
				html += '<li>' + line.slice(2) + '</li>';
				continue;
				}

				// Close lists
				if (inUnorderedList) {
				html += '</ul>';
				inUnorderedList = false;
				}
				if (inOrderedList) {
				html += '</ol>';
				inOrderedList = false;
				}

				// Paragraph or break
				if (line !== '') {
				html += '<p>' + line + '</p>';
				} else {
				html += '<br>';
				}
			}

			if (inUnorderedList) html += '</ul>';
			if (inOrderedList) html += '</ol>';

			return html;
		}

		// Conversation history functions
		function toggleConversationHistory() {
			const historyDiv = document.getElementById('conversationHistory');
			const chatContainer = document.getElementById('chatContainer');
			
			if (historyDiv.style.display === 'none') {
				// Show conversation history
				requestConversationList();
				historyDiv.style.display = 'block';
				chatContainer.style.display = 'none';
			} else {
				// Hide conversation history
				historyDiv.style.display = 'none';
				chatContainer.style.display = 'flex';
			}
		}

		function requestConversationList() {
			vscode.postMessage({
				type: 'getConversationList'
			});
		}

		function loadConversation(filename) {
			console.log('Loading conversation:', filename);
			vscode.postMessage({
				type: 'loadConversation',
				filename: filename
			});
			
			// Hide conversation history and show chat
			toggleConversationHistory();
		}

		// File picker functions
		function showFilePicker() {
			// Request initial file list from VS Code
			vscode.postMessage({
				type: 'getWorkspaceFiles',
				searchTerm: ''
			});
			
			// Show modal
			filePickerModal.style.display = 'flex';
			fileSearchInput.focus();
			selectedFileIndex = -1;
		}

		function hideFilePicker() {
			filePickerModal.style.display = 'none';
			fileSearchInput.value = '';
			selectedFileIndex = -1;
		}

		function getFileIcon(filename) {
			const ext = filename.split('.').pop()?.toLowerCase();
			switch (ext) {
				case 'js': case 'jsx': case 'ts': case 'tsx': return '📄';
				case 'html': case 'htm': return '🌐';
				case 'css': case 'scss': case 'sass': return '🎨';
				case 'json': return '📋';
				case 'md': return '📝';
				case 'py': return '🐍';
				case 'java': return '☕';
				case 'cpp': case 'c': case 'h': return '⚙️';
				case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': return '🖼️';
				case 'pdf': return '📄';
				case 'zip': case 'tar': case 'gz': return '📦';
				default: return '📄';
			}
		}

		function renderFileList() {
			fileList.innerHTML = '';
			
			filteredFiles.forEach((file, index) => {
				const fileItem = document.createElement('div');
				fileItem.className = 'file-item';
				if (index === selectedFileIndex) {
					fileItem.classList.add('selected');
				}
				
				fileItem.innerHTML = \`
					<span class="file-icon">\${getFileIcon(file.name)}</span>
					<div class="file-info">
						<div class="file-name">\${file.name}</div>
						<div class="file-path">\${file.path}</div>
					</div>
				\`;
				
				fileItem.addEventListener('click', () => {
					selectFile(file);
				});
				
				fileList.appendChild(fileItem);
			});
		}

		function selectFile(file) {
			// Insert file path at cursor position
			const cursorPos = messageInput.selectionStart;
			const textBefore = messageInput.value.substring(0, cursorPos);
			const textAfter = messageInput.value.substring(cursorPos);
			
			// Replace the @ symbol with the file path
			const beforeAt = textBefore.substring(0, textBefore.lastIndexOf('@'));
			const newText = beforeAt + '@' + file.path + ' ' + textAfter;
			
			messageInput.value = newText;
			messageInput.focus();
			
			// Set cursor position after the inserted path
			const newCursorPos = beforeAt.length + file.path.length + 2;
			messageInput.setSelectionRange(newCursorPos, newCursorPos);
			
			hideFilePicker();
			adjustTextareaHeight();
		}

		function filterFiles(searchTerm) {
			// Send search request to backend instead of filtering locally
			vscode.postMessage({
				type: 'getWorkspaceFiles',
				searchTerm: searchTerm
			});
			selectedFileIndex = -1;
		}

		// Image handling functions
		function selectImage() {
			// Use VS Code's native file picker instead of browser file picker
			vscode.postMessage({
				type: 'selectImageFile'
			});
		}


		function showImageAddedFeedback(fileName) {
			// Create temporary feedback element
			const feedback = document.createElement('div');
			feedback.textContent = \`Added: \${fileName}\`;
			feedback.style.cssText = \`
				position: fixed;
				top: 20px;
				right: 20px;
				background: var(--vscode-notifications-background);
				color: var(--vscode-notifications-foreground);
				padding: 8px 12px;
				border-radius: 4px;
				font-size: 12px;
				z-index: 1000;
				opacity: 0;
				transition: opacity 0.3s ease;
			\`;
			
			document.body.appendChild(feedback);
			
			// Animate in
			setTimeout(() => feedback.style.opacity = '1', 10);
			
			// Animate out and remove
			setTimeout(() => {
				feedback.style.opacity = '0';
				setTimeout(() => feedback.remove(), 300);
			}, 2000);
		}

		function displayConversationList(conversations) {
			const listDiv = document.getElementById('conversationList');
			listDiv.innerHTML = '';

			if (conversations.length === 0) {
				listDiv.innerHTML = '<p style="text-align: center; color: var(--vscode-descriptionForeground);">No conversations found</p>';
				return;
			}

			conversations.forEach(conv => {
				const item = document.createElement('div');
				item.className = 'conversation-item';
				item.onclick = () => loadConversation(conv.filename);

				const date = new Date(conv.startTime).toLocaleDateString();
				const time = new Date(conv.startTime).toLocaleTimeString();

				item.innerHTML = \`
					<div class="conversation-title">\${conv.firstUserMessage.substring(0, 60)}\${conv.firstUserMessage.length > 60 ? '...' : ''}</div>
					<div class="conversation-meta">\${date} at \${time} • \${conv.messageCount} messages • $\${conv.totalCost.toFixed(3)}</div>
					<div class="conversation-preview">Last: \${conv.lastUserMessage.substring(0, 80)}\${conv.lastUserMessage.length > 80 ? '...' : ''}</div>
				\`;

				listDiv.appendChild(item);
			});
		}
	</script>
</body>
</html>`;
	}

	public dispose() {
		if (this._panel) {
			this._panel.dispose();
			this._panel = undefined;
		}

		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}