# Separate employer profile onboarding

Branch: feat/employer-profile-onboarding. Base main: d919edb1da26e79b3ef5ea7c8f1ac79568227097.

Previously every `job:employer` opened company entry and profile completion went
straight to a vacancy title. The profile was persisted, but the user could not
finish registration independently from creating a vacancy.

Now `🏢 İşçi axtarıram` opens the employer profile:

- New profile: company → required VÖEN → validated email → profile saved.
- Existing incomplete profile: only missing company/VÖEN/email is requested.
- Existing complete profile: saved-profile panel opens immediately.
- No vacancy is inserted during profile registration. The user must choose
  `Vakansiya əlavə et` to start vacancy title entry. Company and credentials are
  reused; employer phone is still optional per vacancy and WhatsApp ID is not
  made public. Company can be changed through `✏️ Şirkəti dəyiş`.
- Office/hybrid location remains mandatory for each individual vacancy. Remote
  still skips GPS. Supabase canonical jobs, Telegram moderation and direct admin
  publication, filters, matching, detail and pagination remain as implemented.
- Explicit redraft restarts the vacancy without repeating company registration.
- New Add/Edit controls are accepted only in employer states; stale controls do
  not interrupt seeker/filter states. Main menu cancels active flow. Legacy draft
  confirmation resumes after collecting missing credentials as before.

No schema change or additional migration is needed. The already-added employer
company_name/voen/email fields and namespaced metadata are reused. No production
permissions, RLS, migration, data, secrets or Render configuration are changed.
The earlier blocked RLS change is outside this update.

Validation: typecheck, Nest build and all 122 tests pass. Eight new tests cover
registration without vacancy insertion, returning employer, incomplete legacy
profile, explicit company change, stale controls, per-vacancy GPS, redraft and
native WhatsApp button limits. Existing tests now explicitly choose Add after
profile completion. CI runs on this branch. No production merge/deploy performed.
