-- 0004: the old forum-ingestion system is gone (plan 6). The forum_posts
-- table (0001) is dropped; the mod_threads/seen_events mirror tables
-- (0003) and the auth tables (0002) stay.
DROP TABLE IF EXISTS forum_posts;
