/**
 * Tasks: every piece of work as a card with an id, an owner and a column, on
 * a Board, a List or Cards. Owned by the `wsTasks` unit.
 *
 * The ledger (hive/tasks.json) is the orchestrator's: agents move their own
 * cards, and what they write shows up here on the next poll. The human's
 * moves do NOT write the ledger. Dragging a card, moving it with the keyboard
 * or picking a column or owner STAGES the change (workspace/tasks/movesStore),
 * and one Send hands every staged change to the orchestrator as a single
 * message saying exactly what to write — he applies them, and the cards move
 * when he does. New task is the one direct write (and it tells him too).
 *
 * Pieces: data in tasks/useTaskBoard, the pure rules in
 * @shared/workspace/tasks*, the three views and the Send bar in tasks/.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import {
  ASSIGNEE_ALL,
  ASSIGNEE_NONE,
  filterTasks,
  isTaskRange,
  summarizeTasks,
  TASK_RANGES,
  type TaskColumn,
  type TaskRange
} from '@shared/workspace/tasks';
import { buildMoveMessage } from '@shared/workspace/tasksMoves';
import { buildTaskViews, listOrder, type TaskView } from '@shared/workspace/tasksView';
import { deliverToAgent } from '../deliver';
import { loadWsPref, saveWsPref, useWorkspace } from '../store';
import { Button, EmptyState, Screen, ScreenHeader, SearchInput, SegmentedControl, Spinner, WsIcon } from '../ui';
import type { WorkspaceScreenProps } from '../types';
import { BoardView } from '../tasks/BoardView';
import { CardsView } from '../tasks/CardsView';
import { ListView } from '../tasks/ListView';
import { NewTaskDialog } from '../tasks/NewTaskDialog';
import { SendBar } from '../tasks/SendBar';
import { isTasksView, RANGE_LABEL, TASK_VIEWS, type TasksView } from '../tasks/meta';
import { useStagedMoves, useSentMoves, useTaskMoves } from '../tasks/movesStore';
import { localWeekStart, reconcileWithLedger, useTaskBoard } from '../tasks/useTaskBoard';
import '../tasks/tasks.css';

/** How long "Sent to …" stays in the bar after a send. */
const SENT_NOTICE_MS = 6000;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function TasksScreen({ config }: WorkspaceScreenProps) {
  void config;
  const { t } = useTranslation();
  const data = useTaskBoard();
  const { tasks, activity, now, nameOf, owners, loaded } = data;
  const navigate = useWorkspace((s) => s.navigate);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const godOnFloor = useStore((s) => s.agents.some((a) => a.isGod && !!a.ptyId));

  // Remembered per person: the view, the range and the assignee filter. The
  // search text is not — a stale search silently hiding cards is worse than
  // retyping one.
  const [view, setViewState] = useState<TasksView>(() => loadWsPref('tasks.view', 'board', isTasksView));
  const [range, setRangeState] = useState<TaskRange>(() => loadWsPref('tasks.range', 'all', isTaskRange));
  const [assignee, setAssigneeState] = useState<string>(() => loadWsPref('tasks.assignee', ASSIGNEE_ALL, isString));
  const [query, setQuery] = useState('');
  const setView = (v: TasksView) => { setViewState(v); saveWsPref('tasks.view', v); };
  const setRange = (r: TaskRange) => { setRangeState(r); saveWsPref('tasks.range', r); };
  const setAssignee = (a: string) => { setAssigneeState(a); saveWsPref('tasks.assignee', a); };

  const staged = useStagedMoves();
  const sent = useSentMoves();
  const dispatch = useTaskMoves((s) => s.dispatch);
  const commitSent = useTaskMoves((s) => s.commitSent);

  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState<number | null>(null);

  useEffect(() => {
    if (sentCount === null) return;
    const id = setTimeout(() => setSentCount(null), SENT_NOTICE_MS);
    return () => clearTimeout(id);
  }, [sentCount]);

  const weekStartsOn = useMemo(() => localWeekStart(), []);

  // An assignee filter for someone no longer around (and owning nothing) would
  // hide the whole board behind a choice the picker cannot show; fall back.
  const assigneeValid = assignee === ASSIGNEE_ALL || assignee === ASSIGNEE_NONE || owners.some((o) => o.id === assignee);
  const effectiveAssignee = assigneeValid || !loaded ? assignee : ASSIGNEE_ALL;

  const filtered = useMemo(
    () => filterTasks(tasks, { range, assignee: effectiveAssignee, query }, { now, weekStartsOn, activity, nameOf }),
    [tasks, range, effectiveAssignee, query, now, weekStartsOn, activity, nameOf]
  );
  const views = useMemo(() => buildTaskViews(filtered, { activity, staged, sent, now }), [filtered, activity, staged, sent, now]);
  const ordered = useMemo(() => (view === 'board' ? views : listOrder(views, now)), [view, views, now]);
  const summary = useMemo(() => summarizeTasks(tasks), [tasks]);

  const stage = useCallback((v: TaskView, change: { toColumn?: TaskColumn; toOwner?: string | null }) => {
    setSendError(null);
    dispatch({
      type: 'stage',
      taskId: v.task.id,
      title: v.task.title,
      fromColumn: v.task.column,
      fromOwner: v.task.assignee ?? null,
      toColumn: change.toColumn,
      toOwner: change.toOwner,
      now: Date.now()
    });
  }, [dispatch]);
  const undo = useCallback((taskId: string) => dispatch({ type: 'undo', taskId }), [dispatch]);
  const openCard = useCallback((taskId: string) => openTaskDetail(taskId), [openTaskDetail]);
  const toAskMe = useCallback(() => navigate({ kind: 'inbox', section: 'askme' }), [navigate]);

  const send = async () => {
    // Describe each move against the ledger as it is now, not as it was at
    // the last poll's reconcile.
    if (loaded) reconcileWithLedger(tasks);
    const st = useTaskMoves.getState();
    const moves = st.buckets[st.ledgerId]?.staged ?? [];
    if (!moves.length || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await deliverToAgent({
        target: { kind: 'orchestrator' },
        text: buildMoveMessage(moves, nameOf),
        mode: 'queue',
        source: 'tasks'
      });
      if (!res.ok) throw new Error(res.error || t('wsTasks.send.failedGeneric'));
      commitSent(moves, Date.now());
      setSentCount(moves.length);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const subtitle = !loaded
    ? undefined
    : summary.total === 0
      ? t('wsTasks.summary.empty')
      : summary.asksYou > 0
        ? t('wsTasks.summary.join', {
          a: t('wsTasks.summary.inProgress', { count: summary.doing }),
          b: summary.asksYou === 1 ? t('wsTasks.summary.asksYouOne', { count: 1 }) : t('wsTasks.summary.asksYouMany', { count: summary.asksYou })
        })
        : t('wsTasks.summary.inProgress', { count: summary.doing });

  const header = (
    <ScreenHeader
      title={t('wsTasks.title')}
      subtitle={subtitle}
      actions={
        <>
          <SegmentedControl<TasksView>
            ariaLabel={t('wsTasks.view.label')}
            value={view}
            onChange={setView}
            options={TASK_VIEWS.map((v) => ({ value: v, label: t(`wsTasks.view.${v}`) }))}
          />
          <Button variant="primary" icon={<WsIcon name="plus" />} onClick={() => setCreating(true)}>
            {t('wsTasks.newTask.button')}
          </Button>
        </>
      }
    />
  );

  const filtersActive = range !== 'all' || effectiveAssignee !== ASSIGNEE_ALL || !!query.trim();
  const clearFilters = () => { setRange('all'); setAssignee(ASSIGNEE_ALL); setQuery(''); };

  let body: JSX.Element;
  if (!loaded) {
    body = <EmptyState fill icon={<Spinner label={t('wsTasks.loading')} />} title={t('wsTasks.loading')} />;
  } else if (tasks.length === 0) {
    body = (
      <EmptyState
        fill
        icon={<WsIcon name="tasks" size={24} />}
        title={t('wsTasks.empty.title')}
        body={t('wsTasks.empty.body')}
        action={<Button variant="primary" icon={<WsIcon name="plus" />} onClick={() => setCreating(true)}>{t('wsTasks.newTask.button')}</Button>}
      />
    );
  } else if (views.length === 0) {
    body = (
      <EmptyState
        fill
        title={t('wsTasks.empty.filteredTitle')}
        body={t('wsTasks.empty.filteredBody')}
        action={<Button onClick={clearFilters}>{t('wsTasks.filter.clear')}</Button>}
      />
    );
  } else if (view === 'board') {
    body = (
      <BoardView
        views={ordered}
        now={now}
        nameOf={nameOf}
        owners={owners}
        onOpen={openCard}
        onStage={stage}
        onUndo={undo}
        onAsks={toAskMe}
        onShowList={() => setView('list')}
      />
    );
  } else if (view === 'list') {
    body = <ListView views={ordered} now={now} nameOf={nameOf} owners={owners} onOpen={openCard} onStage={stage} onUndo={undo} onAsks={toAskMe} />;
  } else {
    body = <CardsView views={ordered} now={now} nameOf={nameOf} owners={owners} onOpen={openCard} onStage={stage} onUndo={undo} onAsks={toAskMe} />;
  }

  return (
    <Screen header={header} fill>
      {loaded && tasks.length > 0 && (
        <div className="cth-ws-tasks-toolbar">
          <SegmentedControl<TaskRange>
            size="sm"
            ariaLabel={t('wsTasks.filter.range')}
            value={range}
            onChange={setRange}
            options={TASK_RANGES.map((r) => ({ value: r, label: t(RANGE_LABEL[r]) }))}
          />
          <select
            className="cth-ws-tasks-select"
            aria-label={t('wsTasks.filter.assignee')}
            value={effectiveAssignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value={ASSIGNEE_ALL}>{t('wsTasks.filter.everyone')}</option>
            <option value={ASSIGNEE_NONE}>{t('wsTasks.unassigned')}</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>{o.isGod ? t('wsTasks.ownerGod', { name: o.name }) : o.name}</option>
            ))}
          </select>
          <SearchInput value={query} onChange={setQuery} placeholder={t('wsTasks.filter.search')} />
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>{t('wsTasks.filter.clear')}</Button>
          )}
          <span className="cth-ws-tasks-toolbar-meta">
            {view === 'board' ? t('wsTasks.kbd.short') : t('wsTasks.filter.showing', { shown: views.length, total: tasks.length })}
          </span>
        </div>
      )}
      {notice && (
        <div className="cth-ws-tasks-notice" role="status">
          {notice}{' '}
          <button type="button" className="cth-ws-tasks-link" onClick={() => setNotice(null)}>{t('wsTasks.dismiss')}</button>
        </div>
      )}
      {body}
      <SendBar
        staged={staged}
        nameOf={nameOf}
        sending={sending}
        error={sendError}
        sentCount={sentCount}
        godAway={!godOnFloor}
        onSend={() => void send()}
        onDiscard={() => { dispatch({ type: 'clear' }); setSendError(null); }}
        onUndo={undo}
      />
      {creating && (
        <NewTaskDialog
          owners={owners}
          folderKey={data.folderKey}
          nameOf={nameOf}
          onClose={() => setCreating(false)}
          onCreated={({ id, told, tellError }) => {
            data.refreshActivity();
            setNotice(told
              ? t('wsTasks.newTask.created', { id })
              : t('wsTasks.newTask.createdNotTold', { id, error: tellError ?? '' }));
          }}
        />
      )}
    </Screen>
  );
}
