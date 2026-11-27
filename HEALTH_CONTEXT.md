# H-CAR Health Context: Biological Sex, Cycles, Pregnancy, Medications, Altitude, Menopause

Optional, private context a user can provide so the detector adjusts to
their body. Everything here is opt-in. Users can leave it all unset and
the app works exactly as before.

## What it does

The detector learns a personal baseline and flags sustained multi-signal
changes. Some normal life events move the same signals the detector
watches. Without context, those normal changes look abnormal and cause
false flags. Health context tells the detector what to expect so it
only flags changes that are unusual for that person in that situation.

## Features

### Biological sex

- Field on the user account: `male`, `female`, `prefer_not_to_say`, or
  unset (NULL).
- Set in Profile, in the About You card.
- Used only to show the cycle, pregnancy, and menopause sections (female
  users) and to enable cycle adjustment. It is never shown to other
  users and never used for anything else.

### Menstrual cycle tracking

- Table `menstrual_cycles`: id, user_id, start_date, end_date (optional),
  notes, created_at.
- Endpoints: POST /api/cycle, GET /api/cycle, DELETE /api/cycle/:id.
- Phase calculation (cycle.js): day 1 to 14 is follicular, day 15 until
  the next cycle starts is luteal. Phase is unknown when no cycle is
  logged, when the date is before the first logged cycle, or when the
  most recent cycle started over 45 days ago.
- Detector adjustment: on luteal days, resting heart rate is corrected
  down 2.5 bpm and skin temperature down 0.4 C before z-scoring. Those
  are conservative mid-range values for the expected luteal rises
  (RHR up 2 to 3 bpm, temperature up 0.3 to 0.5 C). HRV dips in the
  luteal phase but no single magnitude is well established, so HRV is
  not corrected.
- Baseline learning always uses the original values.

### Pregnancy tracking

- Table `pregnancies`: id, user_id, start_date, due_date, end_date,
  status (`active`, `completed`, `ended`), created_at.
- Endpoints: POST /api/pregnancy, GET /api/pregnancy,
  DELETE /api/pregnancy/:id.
- Detector adjustment (context.js): resting heart rate rises gradually
  in pregnancy, roughly 10 to 20 bpm by term. The correction scales
  linearly from 0 at conception to 15 bpm (the middle of the range) at
  40 weeks, and stays at 15 after that.
- Sleep and HRV also change in pregnancy, but no correction is applied
  to them because no single magnitude is well established.

### Medication logging

- Table `medications`: id, user_id, name, start_date, end_date,
  dosage, notes, created_at.
- Endpoints: POST /api/medication, GET /api/medication,
  DELETE /api/medication/:id.
- Detector behaviour: a medication started within the last 14 days is
  noted as context on that day's result only. No effect is predicted.
  H-CAR does not know what a medication does to your body and does not
  try to guess. The note is there so you have the context when you
  look at a flag.

### Altitude tracking

- Field `altitude_m` on `daily_summaries`, set through POST /api/altitude
  (or the altitude question in the morning check-in). GET /api/altitude
  lists recent entries.
- Detector adjustment (context.js): at or above 1500 m, blood oxygen
  runs about 90 to 94 percent instead of 95 to 100 percent. SpO2 is
  corrected up 3 percentage points before z-scoring on high-altitude
  days. Breathing rate also runs higher at altitude, but no single
  magnitude is well established, so it is not corrected.

### Menopause status

- Field on the user account: `pre`, `peri`, `post`, or unset (NULL).
- Set in Profile, in the About You card (shown for female users).
- Detector adjustment (context.js): for perimenopausal users, the
  nightly temperature sigma floor is widened from 0.15 C to 0.30 C, so
  normal temperature swings (hot flashes) are less likely to trigger
  a flag. Pre- and post-menopause apply no adjustment.

## Where context is recorded

- `detector_results.cycle_phase`: follicular, luteal, or NULL.
- `detector_results.context_json`: JSON with cyclePhase, pregnant,
  pregnantWeeks, altitudeM, medChangeRecent, and menopauseStatus.
- Both are returned by GET /api/days so the app can show why a flag
  was or was not raised on a given day.
- Re-running the detector (on every sync, and after any cycle,
  pregnancy, medication, or altitude change) recomputes all context
  from scratch, so corrections apply retroactively to past days.

## Automatic elevation detection

Altitude used to be manual only (the morning check-in question). It
can now be detected automatically, because people will not remember
to log it. The Fitbit and Google Health sync does not carry
elevation, so the phone location is the source, not the wearable.

- Opt-in toggle in Profile, About You: "Automatically detect
  elevation". Off by default.
- When on, the app runs one detection when the dashboard loads and
  when the morning check-in loads. It asks the phone for its
  position, looks up ground elevation on the phone through Open-Meteo
  (free, no key), with OpenTopoData as a fallback, then posts only
  the elevation in metres to the existing POST /api/altitude
  endpoint. At most one attempt per day, and a value is recorded
  only when it is a new day or moved by more than 100 m.
- The check-in shows "Detected elevation: X m" and prefills the
  manual input when it is empty. A manual value always wins.
- Privacy: coordinates are sent only to the elevation lookup service
  to get the number back. They are never sent to H-CAR servers,
  never stored in the database, logs, or localStorage. Only the date
  and the elevation in metres are stored. When detection is off, or
  geolocation is denied, unavailable, or times out, nothing happens
  and the manual check-in question is the fallback.
- The existing SpO2 correction is unchanged: at or above 1500 m the
  detector still adds 3 points before scoring, whether the value was
  typed in or detected.
- Tests: test-elevation.js, 35 tests.

## What this is NOT

- It does not diagnose menstrual disorders, pregnancy complications,
  medication side effects, or menopause-related conditions.
- It does not predict ovulation, fertility, periods, or due dates.
- It does not predict medication effects.
- It does not replace a clinician. If you feel unwell, seek
  professional medical care.

## Privacy

- All health context is optional and private to the user.
- It is never shown to family members on the Family Dashboard or to
  emergency contacts in alerts.
- It is never used for advertising and never sold.
- It is stored in the same encrypted-at-rest Postgres database as the
  rest of the user's data.
- Deleting a cycle, pregnancy, or medication entry removes it and
  re-runs the detector without it.
- The privacy policy (public/privacy.html) states this in section 1.

## Files

- `cycle.js`: cycle phase calculation and luteal corrections.
- `context.js`: pregnancy, altitude, menopause, and medication helpers.
- `detector.js`: applies the corrections before z-scoring and records
  context on each day result. Core detector math is unchanged; without
  context the detector behaves exactly as before.
- `server.js`: schema, API endpoints, and context loading in
  `runDetectorForUser`.
- `public/index.html`: About You card, Cycle card, Pregnancy card,
  Medications card, the altitude question in the morning check-in,
  the automatic elevation toggle, and the detected elevation note.
- `public/elevation.js`: client-side elevation lookup, dedupe, and
  recording. Coordinates never leave the device except to the lookup
  service; only the elevation in metres is saved.
- `test-cycle.js`: 14 tests for cycle phase and the luteal adjustment.
- `test-context.js`: 17 tests for pregnancy, altitude, menopause,
  medication context, and the detector adjustments.
- `test-elevation.js`: 35 tests for lookup parsing, the 1500 m
  correction on detected values, coordinates never being persisted,
  and geolocation failure falling back to manual.
