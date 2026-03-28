import * as vscode from 'vscode';

let hiddenDecoration: vscode.TextEditorDecorationType | undefined;
let isHidden = false;
let statusBarItem: vscode.StatusBarItem;
// Maps doc URI → start lines of multi-line comment blocks - excludes blocks that were already collapsed before NDA stepped in
const ndaAddedFolds = new Map<string, number[]>();

interface CommentBlock { start: number; end: number; }

class XmlCommentFoldingProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        let blockStart = -1;

        for (let i = 0; i < document.lineCount; i++) {
            const isComment = document.lineAt(i).text.trimStart().startsWith('///');
            if (isComment && blockStart === -1) blockStart = i;
            if (!isComment && blockStart !== -1) {
                if (i - 1 > blockStart) {
                    ranges.push(new vscode.FoldingRange(blockStart, i - 1, vscode.FoldingRangeKind.Comment));
                }
                blockStart = -1;
            }
        }
        if (blockStart !== -1 && document.lineCount - 1 > blockStart) {
            ranges.push(new vscode.FoldingRange(blockStart, document.lineCount - 1, vscode.FoldingRangeKind.Comment));
        }

        return ranges;
    }
}

export function activate(context: vscode.ExtensionContext) {

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'nda.toggle';
    statusBarItem.tooltip = 'NDA: Toggle XML doc comment visibility (Ctrl+Shift+/)';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'csharp' },
            new XmlCommentFoldingProvider()
        )
    );

    function buildDecoration(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            // Make the actual /// text invisible and collapse its width.
            color: 'rgba(0, 0, 0, 0)',
            letterSpacing: '-9999em',
            before: {
                contentText: 'No Docs Allowed',
                color: new vscode.ThemeColor('editorLineNumber.foreground'),
                fontStyle: 'italic',
            },
        });
    }

    function getCommentBlocks(document: vscode.TextDocument): CommentBlock[] {
        const blocks: CommentBlock[] = [];
        let blockStart = -1;

        for (let i = 0; i < document.lineCount; i++) {
            const isComment = document.lineAt(i).text.trimStart().startsWith('///');
            if (isComment && blockStart === -1) blockStart = i;
            if (!isComment && blockStart !== -1) {
                blocks.push({ start: blockStart, end: i - 1 });
                blockStart = -1;
            }
        }
        if (blockStart !== -1) {
            blocks.push({ start: blockStart, end: document.lineCount - 1 });
        }
        return blocks;
    }

    // Returns start lines of multi-line comment blocks that NDA is about to fold.
    function getNdaNewFoldLines(editor: vscode.TextEditor, blocks: CommentBlock[]): number[] {
        const vr = editor.visibleRanges;
        return blocks
            .filter(b => {
                if (b.end === b.start) return false; // single-line: can't fold
                const headerVis = vr.some(r => r.start.line <= b.start && r.end.line >= b.start);
                const intVis = vr.some(r => r.start.line <= b.start + 1 && r.end.line >= b.start + 1);
                return !(headerVis && !intVis); // skip clearly-already-folded blocks
            })
            .map(b => b.start);
    }

    // Apply NDA to a single editor: snapshot pre-fold state, fold all comment blocks, decorate.
    async function applyNdaToEditor(editor: vscode.TextEditor) {
        const uri = editor.document.uri.toString();
        if (ndaAddedFolds.has(uri)) {
            // Already applied — the file is still folded from the first visit.
            // Do NOT overwrite the snapshot: the blocks now look "already folded"
            applyDecorations(editor);
            return;
        }
        const blocks = getCommentBlocks(editor.document);
        const allMultiLine = blocks.filter(b => b.end > b.start).map(b => b.start);
        const newFolds = allMultiLine.length > 0 ? getNdaNewFoldLines(editor, blocks) : [];
        ndaAddedFolds.set(uri, newFolds);
        if (allMultiLine.length > 0) {
            await vscode.commands.executeCommand('editor.fold', {
                selectionLines: allMultiLine,
                levels: 1,
            });
        }
        applyDecorations(editor);
    }

    // Revert NDA from a single editor: unfold only the lines NDA added, clear decorations.
    async function revertNdaFromEditor(editor: vscode.TextEditor) {
        clearDecorations(editor);
        const uri = editor.document.uri.toString();
        const linesToUnfold = ndaAddedFolds.get(uri) ?? [];
        ndaAddedFolds.delete(uri);
        if (linesToUnfold.length === 0) return;
        await vscode.commands.executeCommand('editor.unfold', {
            selectionLines: linesToUnfold,
            levels: 1,
        });
    }

    // Returns a range from the '///' start to end-of-line
    function commentRange(editor: vscode.TextEditor, line: number): vscode.Range {
        const lineText = editor.document.lineAt(line).text;
        const col = lineText.indexOf('///');
        const start = new vscode.Position(line, col >= 0 ? col : 0);
        const end = editor.document.lineAt(line).range.end;
        return new vscode.Range(start, end);
    }

    function applyDecorations(editor: vscode.TextEditor) {
        if (!isHidden || !hiddenDecoration) return;
        if (!ndaAddedFolds.has(editor.document.uri.toString())) return;

        const visibleRanges = editor.visibleRanges;
        const ranges: vscode.Range[] = [];

        for (const block of getCommentBlocks(editor.document)) {
            if (block.end === block.start) {
                // Single-line blocks can't be folded — always show placeholder.
                ranges.push(commentRange(editor, block.start));
                continue;
            }
            // Multi-line: only show placeholder while the interior is hidden (folded).
            const interiorLine = block.start + 1;
            const interiorVisible = visibleRanges.some(
                r => r.start.line <= interiorLine && r.end.line >= interiorLine
            );
            if (!interiorVisible) {
                ranges.push(commentRange(editor, block.start));
            }
        }

        editor.setDecorations(hiddenDecoration, ranges);
    }

    function clearDecorations(editor: vscode.TextEditor) {
        if (hiddenDecoration) {
            editor.setDecorations(hiddenDecoration, []);
        }
    }

    async function hideComments() {
        if (hiddenDecoration) hiddenDecoration.dispose();
        hiddenDecoration = buildDecoration();
        isHidden = true;
        updateStatusBar();

        const editor = vscode.window.activeTextEditor;
        if (editor) await applyNdaToEditor(editor);
    }

    async function showComments() {
        isHidden = false;
        updateStatusBar();

        // Only unfold the active editor — editor.unfold only targets the active editor.
        const editor = vscode.window.activeTextEditor;
        if (editor) await revertNdaFromEditor(editor);

        if (hiddenDecoration) {
            hiddenDecoration.dispose();
            hiddenDecoration = undefined;
        }
    }

    const toggleCmd = vscode.commands.registerCommand('nda.toggle', () => {
        isHidden ? showComments() : hideComments();
    });

    const hideCmd = vscode.commands.registerCommand('nda.hide', () => {
        if (!isHidden) hideComments();
    });

    const showCmd = vscode.commands.registerCommand('nda.show', () => {
        if (isHidden) showComments();
    });

    context.subscriptions.push(toggleCmd, hideCmd, showCmd);

    // When switching tabs:
    // - NDA on  → apply mask to the newly active editor
    // - NDA off → if the newly active editor was NDA-folded, lazy-revert it now
    //             (editor.unfold only targets the active editor, so this is the
    //              only safe place to call it for a previously-folded doc)
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (!editor) return;
            if (isHidden) {
                await applyNdaToEditor(editor);
            } else if (ndaAddedFolds.has(editor.document.uri.toString())) {
                await revertNdaFromEditor(editor);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document && isHidden) {
                applyDecorations(editor);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            if (isHidden) {
                editors
                    .filter(e => ndaAddedFolds.has(e.document.uri.toString()))
                    .forEach(e => applyDecorations(e));
            }
        })
    );

    // When the user folds/unfolds a region in the gutter the visible ranges change.
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges(event => {
            if (isHidden) applyDecorations(event.textEditor);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(() => {
            const config = vscode.workspace.getConfiguration('nda');
            if (config.get<boolean>('hideOnOpen', false) && !isHidden) {
                hideComments();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('nda') && isHidden) {
                hideComments();
            }
        })
    );
}

function updateStatusBar() {
    if (isHidden) {
        statusBarItem.text = '$(eye-closed) NDA';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = '$(eye) NDA';
        statusBarItem.backgroundColor = undefined;
    }
}

export function deactivate() {
    if (hiddenDecoration) hiddenDecoration.dispose();
    statusBarItem?.dispose();
}
