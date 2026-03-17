/**
 * Shared constant for alt-text scoring and failure profiling.
 * Modes where resolution means /Alt has been REMOVED (hasAlt=false = resolved).
 * All other ownership modes resolve when /Alt is PRESENT (hasAlt=true = resolved).
 */
export const ALT_REMOVAL_MODES = new Set<string>(['orphaned_alt_empty_element', 'nonfigure_with_alt'])
