-- Sheet sources that failed under the old strict import rules are retried
-- immediately with the new tolerant import instead of waiting for the back-off.
update public.sheet_sources
   set consecutive_failures = 0, last_synced_at = null
 where consecutive_failures > 0 or last_sync_status = 'failed';
