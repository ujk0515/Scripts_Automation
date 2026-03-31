import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { api } from '../../ipc/ipcClient';
import type { FileTreeNode } from '@shared/types/project';
import { setFileDrag } from '../EditorPanel/EditorPanel';

interface ContextMenuState {
  x: number;
  y: number;
  node: FileTreeNode;
}

const ContextMenu: React.FC<{
  menu: ContextMenuState;
  projectPath: string;
  onClose: () => void;
  onRefresh: () => void;
  onRename: (node: FileTreeNode) => void;
}> = ({ menu, projectPath, onClose, onRefresh, onRename }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleCopyPath = () => {
    const pathWithoutExt = menu.node.path.replace(/\.groovy$/, '');
    navigator.clipboard.writeText(pathWithoutExt);
    onClose();
  };

  const handleRename = () => {
    onRename(menu.node);
    onClose();
  };

  const handleDelete = async () => {
    const confirmed = confirm(`Delete "${menu.node.name}"?`);
    if (!confirmed) {
      onClose();
      return;
    }
    await api().deleteFile({ projectPath, relativePath: menu.node.path });
    onRefresh();
    onClose();
  };

  const btnClass = 'w-full text-left px-3 py-1.5 text-sm text-km-text hover:bg-km-accent/20 cursor-pointer';

  return (
    <div
      ref={menuRef}
      className="fixed bg-km-sidebar border border-km-border rounded shadow-lg py-1 z-50 min-w-[160px]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button className={btnClass} onClick={handleRename}>
        Rename
      </button>
      {(menu.node.type === 'testcase' || menu.node.type === 'suite') && (
        <button className={btnClass} onClick={handleCopyPath}>
          Copy Path
        </button>
      )}
      <div className="border-t border-km-border my-1" />
      <button className={`${btnClass} text-red-400 hover:text-red-300`} onClick={handleDelete}>
        Delete
      </button>
    </div>
  );
};

const TreeNode: React.FC<{
  node: FileTreeNode;
  projectPath: string;
  depth: number;
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
  renamingPath: string | null;
  onRenameSubmit: (node: FileTreeNode, newName: string) => void;
  onRenameCancel: () => void;
  dragOverPath: string | null;
  onDragOverFolder: (path: string | null) => void;
  onDropOnFolder: (targetFolder: string, dragData: { path: string; name: string; type: string }) => void;
  reorderIndicator: { path: string; position: 'above' | 'below' } | null;
  onReorderHover: (indicator: { path: string; position: 'above' | 'below' } | null) => void;
  onReorderDrop: (targetPath: string, position: 'above' | 'below', dragData: { path: string; name: string; type: string }) => void;
}> = ({ node, projectPath, depth, selectedFolder, onSelectFolder, onContextMenu, renamingPath, onRenameSubmit, onRenameCancel, dragOverPath, onDragOverFolder, onDropOnFolder, reorderIndicator, onReorderHover, onReorderDrop }) => {
  const [expanded, setExpanded] = useState(true);
  const { openTab } = useEditorStore();
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState('');

  const isRenaming = renamingPath === node.path;
  const isDragOver = dragOverPath === node.path && node.type === 'folder';
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (isRenaming) {
      const nameWithoutExt = node.name.replace(/\.(groovy|suite)$/, '');
      setRenameValue(nameWithoutExt);
      requestAnimationFrame(() => renameInputRef.current?.select());
    }
  }, [isRenaming]);

  const isSelected = node.type === 'folder' && node.path === selectedFolder;

  const handleClick = async () => {
    if (node.type === 'folder') {
      onSelectFolder(node.path);
      setExpanded(!expanded);
    }
  };

  const handleDoubleClick = async () => {
    if (node.type === 'testcase' || node.type === 'suite') {
      const result = await api().readFile({
        projectPath,
        relativePath: node.path,
      });
      if (result.success) {
        openTab(node.id, node.name, node.path, result.content);
      }
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, node);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (renameValue.trim()) onRenameSubmit(node, renameValue.trim());
    } else if (e.key === 'Escape') {
      onRenameCancel();
    }
  };

  // ─── Drag & Drop ───
  const handleDragStart = (e: React.DragEvent) => {
    const data = { path: node.path, name: node.name, type: node.type };
    e.dataTransfer.setData('application/json', JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'move';
    setFileDrag(data);
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    setFileDrag(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (node.type === 'folder') {
      // 폴더 위 → 폴더 하이라이트 (이동)
      onDragOverFolder(node.path);
      onReorderHover(null);
    } else {
      // 파일 위 → 위/아래 가이드 라인 (순서 변경)
      onDragOverFolder(null);
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position = e.clientY < midY ? 'above' : 'below';
      onReorderHover({ path: node.path, position });
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (dragOverPath === node.path) onDragOverFolder(null);
    if (reorderIndicator?.path === node.path) onReorderHover(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDragOverFolder(null);
    onReorderHover(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      if (data.path === node.path) return;

      if (node.type === 'folder') {
        // 폴더에 드롭 → 이동
        const lastSep = Math.max(data.path.lastIndexOf('/'), data.path.lastIndexOf('\\'));
        const parentDir = data.path.substring(0, lastSep);
        if (parentDir === node.path) return;
        if (data.type === 'folder' && (node.path.startsWith(data.path + '/') || node.path.startsWith(data.path + '\\'))) return;
        onDropOnFolder(node.path, data);
      } else {
        // 파일에 드롭 → 순서 변경
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const position = e.clientY < midY ? 'above' : 'below';
        onReorderDrop(node.path, position, data);
      }
    } catch {}
  };

  const icon = node.type === 'folder' ? (expanded ? '▾' : '▸') : node.type === 'suite' ? '▣' : '▪';
  const iconColor = node.type === 'folder' ? 'text-km-warning' : node.type === 'suite' ? 'text-km-success' : 'text-km-accent';

  const showAbove = reorderIndicator?.path === node.path && reorderIndicator.position === 'above';
  const showBelow = reorderIndicator?.path === node.path && reorderIndicator.position === 'below';

  return (
    <div>
      {showAbove && <div className="h-0.5 bg-km-accent mx-2" />}
      <div
        draggable={!isRenaming}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleRightClick}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-km-border/50 text-sm ${
          isSelected ? 'bg-km-accent/20' : ''
        } ${isDragOver ? 'bg-km-accent/30 outline outline-1 outline-km-accent' : ''}${isDragging ? ' opacity-30' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className={`${iconColor} text-xs w-4`}>{icon}</span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => {
              if (renameValue.trim()) onRenameSubmit(node, renameValue.trim());
              else onRenameCancel();
            }}
            className="flex-1 bg-km-bg border border-km-accent text-km-text text-sm px-1 py-0 rounded outline-none"
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="text-km-text truncate">{node.name}</span>
        )}
      </div>
      {showBelow && <div className="h-0.5 bg-km-accent mx-2" />}
      {node.type === 'folder' && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              projectPath={projectPath}
              depth={depth + 1}
              selectedFolder={selectedFolder}
              onSelectFolder={onSelectFolder}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              dragOverPath={dragOverPath}
              onDragOverFolder={onDragOverFolder}
              onDropOnFolder={onDropOnFolder}
              reorderIndicator={reorderIndicator}
              onReorderHover={onReorderHover}
              onReorderDrop={onReorderDrop}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const ProjectExplorer: React.FC = () => {
  const { fileTree, projectPath, config, refreshTree } = useProjectStore();
  const [showInput, setShowInput] = useState<'file' | 'folder' | 'suite' | null>(null);
  const [newName, setNewName] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('Test Cases');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [reorderIndicator, setReorderIndicator] = useState<{ path: string; position: 'above' | 'below' } | null>(null);
  const [fileOrder, setFileOrderState] = useState<Record<string, string[]>>({});
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 상하 분할 비율 (px 기준, top panel 높이)
  const containerRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState<number | null>(null); // null = 50%
  const isDragging = useRef(false);

  // 파일 트리 분리: Test Cases / Test Suites
  const testCasesTree = fileTree.filter((n) => !n.path.startsWith('Test Suites'));
  const testSuitesTree = fileTree.filter((n) => n.path.startsWith('Test Suites'));

  // 인풋 노출 시 포커스
  useEffect(() => {
    if (showInput) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [showInput]);

  // Click outside input to cancel
  useEffect(() => {
    if (!showInput) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (inputContainerRef.current && !inputContainerRef.current.contains(e.target as Node)) {
        setShowInput(null);
        setNewName('');
      }
    };
    document.addEventListener('mouseup', handleClickOutside);
    return () => document.removeEventListener('mouseup', handleClickOutside);
  }, [showInput]);

  const handleCreate = async () => {
    if (!projectPath || !newName.trim()) return;

    const isFolder = showInput === 'folder';
    if (showInput === 'suite') {
      const fileName = `${newName.trim()}${newName.endsWith('.suite') ? '' : '.suite'}`;
      const relativePath = `Test Suites/${fileName}`;
      await api().createFile({ projectPath, relativePath, isFolder: false });
      await refreshTree();
      setShowInput(null);
      setNewName('');
      return;
    }

    const basePath = selectedFolder || 'Test Cases';
    const fileName = isFolder
      ? newName.trim()
      : `${newName.trim()}${newName.endsWith('.groovy') ? '' : '.groovy'}`;
    const relativePath = `${basePath}/${fileName}`;

    await api().createFile({ projectPath, relativePath, isFolder });
    await refreshTree();
    setShowInput(null);
    setNewName('');
  };

  const handleContextMenu = (e: React.MouseEvent, node: FileTreeNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleStartRename = (node: FileTreeNode) => {
    setRenamingPath(node.path);
  };

  const handleRenameSubmit = async (node: FileTreeNode, newName: string) => {
    if (!projectPath) return;
    const parentDir = node.path.substring(0, Math.max(node.path.lastIndexOf('/'), node.path.lastIndexOf('\\')));
    const ext = node.type === 'testcase' && !newName.endsWith('.groovy') ? '.groovy'
      : node.type === 'suite' && !newName.endsWith('.suite') ? '.suite' : '';
    const newPath = parentDir ? `${parentDir}/${newName}${ext}` : `${newName}${ext}`;
    if (newPath !== node.path) {
      await api().renameFile({ projectPath, oldPath: node.path, newPath });
      await refreshTree();
    }
    setRenamingPath(null);
  };

  const handleRenameCancel = () => {
    setRenamingPath(null);
  };

  const handleDropOnFolder = async (targetFolder: string, dragData: { path: string; name: string; type: string }) => {
    if (!projectPath) return;
    const newPath = `${targetFolder}/${dragData.name}`;
    const result = await api().moveFile({ projectPath, oldPath: dragData.path, newPath });
    if (result.success) {
      useEditorStore.getState().updateTabPath(dragData.path, newPath);
      await refreshTree();
    }
  };

  // 파일 순서 로드
  useEffect(() => {
    if (projectPath) {
      api().getFileOrder(projectPath).then(setFileOrderState).catch(() => {});
    }
  }, [projectPath, fileTree]);

  // 파일 트리에 커스텀 순서 적용
  const applyOrder = (nodes: FileTreeNode[], parentPath: string): FileTreeNode[] => {
    const order = fileOrder[parentPath];
    if (!order) return nodes; // 커스텀 순서 없으면 기본 정렬
    const sorted = [...nodes].sort((a, b) => {
      const ai = order.indexOf(a.name);
      const bi = order.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return sorted.map(n => n.children
      ? { ...n, children: applyOrder(n.children, n.path) }
      : n
    );
  };

  const orderedTestCasesTree = applyOrder(testCasesTree, 'Test Cases');
  const orderedTestSuitesTree = applyOrder(testSuitesTree, 'Test Suites');

  // 리오더 드롭 처리 (같은 폴더: 순서 변경, 다른 폴더: 이동 후 순서 지정)
  const handleReorderDrop = async (targetPath: string, position: 'above' | 'below', dragData: { path: string; name: string; type: string }) => {
    if (!projectPath) return;
    const dragParent = dragData.path.substring(0, Math.max(dragData.path.lastIndexOf('/'), dragData.path.lastIndexOf('\\')));
    const targetParent = targetPath.substring(0, Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\')));

    // 다른 폴더 → 먼저 파일 이동
    if (dragParent !== targetParent) {
      const newPath = `${targetParent}/${dragData.name}`;
      const result = await api().moveFile({ projectPath, oldPath: dragData.path, newPath });
      if (!result.success) return;
      useEditorStore.getState().updateTabPath(dragData.path, newPath);
      await refreshTree();
    }

    const targetName = targetPath.split(/[\/\\]/).pop()!;
    const dragName = dragData.name;
    const parentPath = dragParent;

    // 현재 순서 가져오기 (없으면 현재 파일 목록 순서)
    const allNodes = parentPath.startsWith('Test Suites') ? orderedTestSuitesTree : orderedTestCasesTree;
    const findChildrenByPath = (nodes: FileTreeNode[], targetPath: string): FileTreeNode[] => {
      for (const n of nodes) {
        if (n.path === targetPath && n.children) return n.children;
        if (n.children) {
          const found = findChildrenByPath(n.children, targetPath);
          if (found.length) return found;
        }
      }
      return [];
    };
    // 최상위 폴더면 allNodes 자체가 siblings
    let siblings = findChildrenByPath(allNodes, parentPath);
    if (siblings.length === 0) {
      // 최상위 레벨 (Test Cases 직하위)
      siblings = allNodes;
    }

    const currentOrder = fileOrder[parentPath] || siblings.map(n => n.name);
    console.log('[REORDER]', { parentPath, dragName, targetName, siblings: siblings.map(n => n.name), currentOrder });

    // 드래그 항목 제거
    const filtered = currentOrder.filter(name => name !== dragName);
    // 타겟 위치 찾기
    const targetIdx = filtered.indexOf(targetName);
    if (targetIdx === -1) return;
    const insertIdx = position === 'above' ? targetIdx : targetIdx + 1;
    filtered.splice(insertIdx, 0, dragName);

    // 저장
    const newOrder = { ...fileOrder, [parentPath]: filtered };
    setFileOrderState(newOrder);
    await api().setFileOrder({ projectPath, order: newOrder });
  };

  // 드래그 리사이즈
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // header 영역(약 28px) 제외
      const relY = ev.clientY - rect.top - 28;
      const maxH = rect.height - 28 - 4; // 4px divider
      const clamped = Math.max(60, Math.min(relY, maxH - 60));
      setTopHeight(clamped);
    };

    const onMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return (
    <div ref={containerRef} className="w-60 bg-km-sidebar border-r border-km-border flex flex-col h-full">
      {/* 전체 헤더 */}
      <div className="px-3 py-2 text-xs font-semibold text-km-text-dim uppercase tracking-wider shrink-0">
        Explorer
      </div>

      {/* ── 상단: Test Cases ── */}
      <div
        className="flex flex-col overflow-hidden"
        style={topHeight !== null ? { height: topHeight, flexShrink: 0 } : { flex: 1 }}
      >
        {/* 섹션 헤더 */}
        <div className="px-3 py-1 text-xs font-semibold text-km-text-dim flex items-center justify-between shrink-0 border-b border-km-border/40">
          <span>Test Cases</span>
          <div className="flex gap-1">
            <button
              onClick={() => setShowInput('file')}
              title="New Test Case"
              className="text-km-text-dim hover:text-white text-base leading-none"
            >
              +
            </button>
            <button
              onClick={() => setShowInput('folder')}
              title="New Folder"
              className="text-km-text-dim hover:text-white text-base leading-none"
            >
              +F
            </button>
          </div>
        </div>

        {showInput && showInput !== 'suite' && (
          <div ref={inputContainerRef} className="px-2 py-1 shrink-0">
            <div className="text-xs text-km-text-dim mb-1">
              in: {selectedFolder || 'Test Cases'}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setShowInput(null); setNewName(''); }
              }}
              placeholder={showInput === 'folder' ? 'Folder name' : 'TestCase.groovy'}
              className="w-full bg-km-bg border border-km-accent rounded px-2 py-1 text-xs text-white focus:outline-none"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-1">
          {config && (
            <div
              onClick={() => setSelectedFolder('Test Cases')}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('application/json')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverPath('Test Cases');
              }}
              onDragLeave={() => {
                if (dragOverPath === 'Test Cases') setDragOverPath(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverPath(null);
                try {
                  const data = JSON.parse(e.dataTransfer.getData('application/json'));
                  if (!data.path) return;
                  const parentDir = data.path.substring(0, Math.max(data.path.lastIndexOf('/'), data.path.lastIndexOf('\\')));
                  if (parentDir === 'Test Cases') return;
                  handleDropOnFolder('Test Cases', data);
                } catch {}
              }}
              className={`px-2 py-1 text-sm font-medium text-white cursor-pointer hover:bg-km-border/50 ${
                selectedFolder === 'Test Cases' ? 'bg-km-accent/20' : ''
              } ${dragOverPath === 'Test Cases' ? 'bg-km-accent/30 outline outline-1 outline-km-accent' : ''}`}
            >
              {config.name}
              <span className="ml-2 text-xs text-km-text-dim">({config.type})</span>
            </div>
          )}
          {orderedTestCasesTree.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              projectPath={projectPath!}
              depth={0}
              selectedFolder={selectedFolder}
              onSelectFolder={setSelectedFolder}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              dragOverPath={dragOverPath}
              onDragOverFolder={setDragOverPath}
              onDropOnFolder={handleDropOnFolder}
              reorderIndicator={reorderIndicator}
              onReorderHover={setReorderIndicator}
              onReorderDrop={handleReorderDrop}
            />
          ))}
        </div>
      </div>

      {/* ── 드래그 핸들 ── */}
      <div
        onMouseDown={handleDividerMouseDown}
        className="h-1 bg-km-border hover:bg-km-accent/60 cursor-row-resize shrink-0 transition-colors"
        title="Drag to resize"
      />

      {/* ── 하단: Test Suites ── */}
      <div className="flex flex-col overflow-hidden flex-1">
        {/* 섹션 헤더 */}
        <div className="px-3 py-1 text-xs font-semibold text-km-text-dim flex items-center justify-between shrink-0 border-b border-km-border/40">
          <span>Test Suites</span>
          <button
            onClick={() => setShowInput('suite')}
            title="New Test Suite"
            className="text-km-text-dim hover:text-white text-base leading-none"
          >
            +S
          </button>
        </div>

        {showInput === 'suite' && (
          <div ref={inputContainerRef} className="px-2 py-1 shrink-0">
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setShowInput(null); setNewName(''); }
              }}
              placeholder="MySuite.suite"
              className="w-full bg-km-bg border border-km-accent rounded px-2 py-1 text-xs text-white focus:outline-none"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-1">
          {orderedTestSuitesTree.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              projectPath={projectPath!}
              depth={0}
              selectedFolder={selectedFolder}
              onSelectFolder={setSelectedFolder}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              dragOverPath={dragOverPath}
              onDragOverFolder={setDragOverPath}
              onDropOnFolder={handleDropOnFolder}
              reorderIndicator={reorderIndicator}
              onReorderHover={setReorderIndicator}
              onReorderDrop={handleReorderDrop}
            />
          ))}
          {testSuitesTree.length === 0 && (
            <div className="px-3 py-2 text-xs text-km-text-dim italic">No suites yet</div>
          )}
        </div>
      </div>

      {contextMenu && projectPath && (
        <ContextMenu
          menu={contextMenu}
          projectPath={projectPath}
          onClose={() => setContextMenu(null)}
          onRefresh={refreshTree}
          onRename={handleStartRename}
        />
      )}
    </div>
  );
};
