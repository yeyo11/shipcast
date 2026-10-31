import { useNavigate } from '@tanstack/react-router';
import { Icon } from '../kit/Icon';
import { Menu } from '../ui/Menu';

/**
 * The launch's "…" while it waits for approval: what the launch menu offers in this state until the
 * shared launch menu (board LaunchMenu) takes its place
 */
export function ApprovalMenu({ launchId, held, onDelete }: { launchId: number; held: boolean; onDelete?: () => void }) {
  const navigate = useNavigate();
  const id = String(launchId);
  return (
    <Menu
      trigger={
        <button type="button" className="k-btn k-icon" aria-label="More actions">
          <Icon name="more" />
        </button>
      }
      entries={[
        { label: 'Edit the text', onSelect: () => void navigate({ to: '/launches/$id/edit', params: { id } }) },
        ...(held ? [{ label: 'Preview the article', onSelect: () => void navigate({ to: '/launches/$id/preview', params: { id } }) }] : []),
        { label: 'Details', onSelect: () => void navigate({ to: '/launches/$id', params: { id }, search: { tab: 'details' } }) },
        ...(onDelete ? [{ kind: 'separator' as const }, { label: 'Delete launch', tone: 'danger' as const, onSelect: onDelete }] : []),
      ]}
    />
  );
}
