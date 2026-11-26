-- New confirmation status: the customer asked to be called back later.
-- (Enum values must be committed before use: the functions using it are in 0022.)
alter type public.confirmation_status add value if not exists 'postponed' before 'cancelled';
