# API contract (shared by backend and front-end)

Plain HTML/CSS/JS, no build step. Backend = Google Apps Script web app (`apps-script/Code.gs`) over a Google Sheet.
Front-end calls `CONFIG.apiUrl` (js/config.js). If `apiUrl` is empty -> DEMO MODE: `js/api.js` uses localStorage with the same behaviour.

All calls: GET `?action=X&...` or POST with `Content-Type: text/plain` body JSON `{action, ...}` (avoids CORS preflight). All replies JSON `{ok:true, ...}` or `{ok:false, error:"code"}`.
Coach calls carry `code` (the coach's personal access code). Wrong/missing -> `{ok:false,error:"unauthorized"}`.

## Public
- `addLead` (POST): `{name, phone, email?, age?, goal, level, area, times, consent:true, website:""(honeypot, must be empty)}`
  -> `{ok:true, id}`. Errors: `invalid`, `consent_required`, `rate_limited`, `spam`.
  Duplicate phone (digits only, last 8) with an existing open lead -> adds an Activity note, returns `{ok:true, id:<existing>, duplicate:true}`.
  Writes Leads row Status=New, sends Telegram message.

## Coach (need `code`)
- `login` (GET): -> `{ok:true, coach:{name}}`
- `leads` (GET): -> `{ok:true, coach, leads:[Lead...], now}` (all leads; each includes computed `flag`: "" | "unclaimed_30" | "unclaimed_120" | "overdue_followup" | "no_contact")
- `lead` (GET `id`): -> `{ok:true, lead, activity:[{time,coach,action,text}]}`
- `claim` (POST `id`): -> `{ok:true, lead}`; if already owned by someone else -> `{ok:false,error:"already_claimed", owner}`. Uses LockService.
- `update` (POST `id`, any of `status`, `nextFollowUp` (YYYY-MM-DD or ""), `lastContact`(ISO)): only the owner (or any coach for unclaimed? NO: owner only) -> `{ok:true, lead}`; else `not_owner`.
- `note` (POST `id`, `text`): any coach -> `{ok:true}`
- `release` (POST `id`): owner gives lead back to the unclaimed pool -> `{ok:true, lead}`
- `addManual` (POST, same fields as addLead minus consent/honeypot, `source:"manual"`): -> `{ok:true,id}`

## Lead object
`{id, created(ISO), name, phone, email, age, goal, level, area, times, source("form"|"manual"), status, owner, claimedAt, lastContact, nextFollowUp, flag}`
Status values (exact): `New`, `Contacted`, `Trial booked`, `Paying`, `Not proceeding`.
Goal values: `5K`, `10K`, `Half marathon`, `Marathon`, `General fitness`, `Other`.

## Sheet tabs / headers (read by header name)
- Leads: Id | Created | Name | Phone | Email | Age | Goal | Level | Area | Times | Source | Status | Owner | Claimed At | Last Contact | Next Follow-up | Reminded Level
- Activity: Lead Id | Time | Coach | Action | Text
- Coaches: Name | Telegram | Code | Active (Yes/No)
Script properties: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SITE_URL` (the crm.html address for links), `SHEET_ID` optional (else bound sheet).

## Reminders (time trigger every 15 min, `checkReminders`)
Pure function `computeFlag_(lead, nowMs)` and `reminderPlan_(leads, nowMs)` (no Sheet/UrlFetch calls inside, so they are unit-testable in Node):
- Status New + no owner: age>=30min -> level 1 ("still unclaimed"); age>=120min -> level 2 (ping all). Each level sent once (`Reminded Level`).
- Owner set, status New and no lastContact after 60 min since claim -> "no_contact" reminder to owner.
- nextFollowUp date < today and status not Paying/Not proceeding -> "overdue_followup" reminder to owner (once per day).
Telegram failure never blocks a save.
