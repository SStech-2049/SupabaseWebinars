// Public Supabase config for the static (browser-only) version.
//
// SAFE TO COMMIT: the anon key is designed to be exposed to browsers. It only
// grants whatever your Row Level Security (RLS) policies allow for the `anon`
// and `authenticated` roles.
//
// NEVER put the service_role key here — that key bypasses RLS and would give
// anyone full read/write access to your database. It stays server-side only.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://nqsyzxwamtwjrhokpjof.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xc3l6eHdhbXR3anJob2twam9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODg5MTgsImV4cCI6MjA5NDg2NDkxOH0.rKcLM82LbO-mz7Bnqg_9CH7pFNnAvOYTsflXJjxDetg',
};
