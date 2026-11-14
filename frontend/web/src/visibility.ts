import type { Memory, Rules, User } from './types';

/**
 * The contract's visibility rule: a user can see a memory if they own it, or
 * their role's `can_see` contains the memory's group or "*".
 *
 * This copy is for display only. The backend is the real enforcer.
 */
export function canSee(user: User, memory: Memory, rules: Rules): boolean {
  if (memory.owner_id === user.id) return true;
  const groups = rules.roles[user.role]?.can_see ?? [];
  return groups.includes('*') || groups.includes(memory.group);
}

/** Short human label for who can access a memory. */
export function visibilityReason(user: User, memory: Memory, rules: Rules): string {
  if (memory.owner_id === user.id) return 'Owner';
  const groups = rules.roles[user.role]?.can_see ?? [];
  if (groups.includes('*')) return 'Full access';
  return groups.includes(memory.group) ? `Shared (${formatGroup(memory.group)})` : `Private (${formatGroup(memory.group)})`;
}

export function formatGroup(group: string): string {
  return group.replace(/_/g, ' ');
}
