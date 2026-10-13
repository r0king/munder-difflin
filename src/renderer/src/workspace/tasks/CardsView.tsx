/**
 * The Cards view: one roomy card per task, with its description, column and
 * last update — for reading the work rather than moving it. Moves and owner
 * changes are still a ⋯ menu away, and stage like everywhere else.
 */
import type { TaskColumn } from '@shared/workspace/tasks';
import type { TaskView } from '@shared/workspace/tasksView';
import { TaskCard } from './TaskCard';
import type { AgentOption } from './useTaskBoard';

export interface CardsViewProps {
  views: TaskView[];
  now: number;
  nameOf: (agentId: string) => string | undefined;
  owners: readonly AgentOption[];
  onOpen: (taskId: string) => void;
  onStage: (view: TaskView, change: { toColumn?: TaskColumn; toOwner?: string | null }) => void;
  onUndo: (taskId: string) => void;
  onAsks: () => void;
}

export function CardsView({ views, now, nameOf, owners, onOpen, onStage, onUndo, onAsks }: CardsViewProps) {
  return (
    <div className="cth-ws-tasks-gridwrap">
      <div className="cth-ws-tasks-grid" role="list">
        {views.map((v) => (
          <TaskCard
            key={v.task.key}
            view={v}
            variant="wide"
            now={now}
            nameOf={nameOf}
            owners={owners}
            tabbable
            onOpen={() => onOpen(v.task.id)}
            onStage={(change) => onStage(v, change)}
            onUndo={() => onUndo(v.task.id)}
            onAsks={onAsks}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter') { e.preventDefault(); onOpen(v.task.id); }
            }}
          />
        ))}
      </div>
    </div>
  );
}
