-- V2-375: Preserve deleted WhatsApp numbers for campaign history.
-- Apply only after a verified production backup.
-- No existing records are deleted or modified.

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
