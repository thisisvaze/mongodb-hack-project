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

/** The reason behind canSee, as a short phrase for the memory card. */
export function visibilityReason(user: User, memory: Memory, rules: Rules): string {
  if (memory.owner_id === user.id) return 'owns this memory';
  const groups = rules.roles[user.role]?.can_see ?? [];
  if (groups.includes('*')) return `role ${user.role} sees everything`;
  return groups.includes(memory.group)
    ? `role ${user.role} can see group ${memory.group}`
    : `role ${user.role} cannot see group ${memory.group}`;
}
