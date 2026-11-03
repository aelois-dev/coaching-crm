# Setting up the backend (Google Sheet + Telegram)

**Please read this first.** This script has been tested only on a pretend copy of Google Sheets inside a computer test. It has **never been run against a real Google Sheet and never sent a real Telegram message.** Expect to fix a small thing or two on the first try. Do the steps one at a time, and after each "Check" tell whoever is helping you what you see.

You will need: a Google account, and the Telegram app on your phone.

## Part A. The Sheet and the script

1. Go to https://sheets.google.com and create a **Blank** spreadsheet. Name it "Coaching CRM" (top-left).
2. In the Sheet, click **Extensions > Apps Script**. A new tab opens with a file called `Code.gs` containing a few lines.
3. Click in the code box, select everything (Ctrl+A, or Cmd+A on Mac) and delete it.
4. Open the file `apps-script/Code.gs` from this project, copy all of it, and paste it into the empty code box.
5. Click the **disk icon** (Save). Name the project "Coaching CRM" if it asks.

## Part B. Run setup (once)

6. At the top, in the function dropdown (it may say "doGet" or similar), choose **setup**, then click **Run**.
7. Google asks for permission. Click **Review permissions**, choose your account. You may see "Google hasn't verified this app": click **Advanced**, then **Go to Coaching CRM (unsafe)** (it is your own script), then **Allow**.
8. Wait for "Execution completed" at the bottom. Click **Execution log** if it is hidden.
   **Check:** the log lists three coaches (Gabriel, Leroi, Carey), each with an **access code**. Write each code down and give each coach only their own. Go back to the Sheet: you should now see tabs **Leads**, **Activity** and **Coaches**.
9. Run **authorizeAll** the same way (choose it in the dropdown, click Run). This asks for the last permission (sending messages to Telegram). Allow it. **Check:** the log says "Permissions OK".

## Part C. Your coaches

10. In the Sheet, open the **Coaches** tab. Gabriel, Leroi and Carey are already there. To add a coach, add a row:
    - **Name**: the coach's first name. Each name must be different. Keep it exactly the same afterwards, because leads are tied to this name.
    - **Telegram**: their Telegram username with an @, for example `@amy_runs`. This is used to tag them in reminders.
    - **Code**: a personal access code for the CRM page. Make it long and hard to guess (for example 3 random words). Never share one coach's code with another.
    - **Active**: `Yes`. Type `No` to switch someone off without deleting them.

## Part D. Telegram bot

11. Open Telegram and search for **@BotFather** (blue tick). Send `/newbot`.
12. It asks for a name (anything, for example "Coaching Leads") and then a username that ends in `bot` (for example `my_run_coaching_bot`).
13. BotFather replies with a long **token** like `123456789:ABC...`. Copy it and keep it private. Anyone with this token can send messages as your bot.
14. Make a Telegram **group** for your coaches and add every coach. Then add your new bot to the group (search for its username in "Add member").
15. Find the group's **chat id**:
    1. In the group, send any message, for example "hello bot".
    2. On a computer, open this address in the browser, replacing `YOUR_TOKEN` with your token (no spaces): `https://api.telegram.org/botYOUR_TOKEN/getUpdates`
    3. Look for `"chat":{"id":-1001234567890`. The number with the minus sign is the chat id. Copy it including the minus.
    4. If the page shows an empty list (`"result":[]`), send another message in the group and reload. If it still shows nothing, in BotFather send `/setprivacy`, choose your bot, choose **Disable**, then send another message in the group.

## Part E. Script properties

16. In the Apps Script tab, click the **gear icon (Project Settings)** on the left.
17. Scroll to **Script properties** and click **Add script property**. Add these, one at a time (the name must be exactly as written, in capitals):

    | Property | Value |
    |---|---|
    | `TELEGRAM_BOT_TOKEN` | the token from step 13 |
    | `TELEGRAM_CHAT_ID` | the chat id from step 15 (with the minus sign) |
    | `SITE_URL` | the web address of your `crm.html` page (you can fill this in later once the site is hosted) |
    | `SHEET_ID` | leave out. Only needed if the script is not opened from inside the Sheet |

18. Click **Save script properties**.
19. Go back to the editor (the `<>` icon), choose **testTelegram** in the dropdown and click **Run**.
    **Check:** a test message appears in your Telegram group. If not, open the Execution log: the most common cause is a wrong token or chat id, or the bot not being in the group.

## Part F. Put it on the web

20. In the Apps Script tab click **Deploy > New deployment**.
21. Click the **gear icon** next to "Select type" and choose **Web app**.
22. Fill in:
    - Description: `v1`
    - **Execute as: Me**
    - **Who has access: Anyone**
23. Click **Deploy**. Copy the **Web app URL** (it ends in `/exec`).
24. Paste that URL as `apiUrl` in the website's `js/config.js` (ask whoever built the site to do this if you are unsure).
    **Check:** open the URL in your browser. You should see `{"ok":true,"service":"coaching-crm"}`. To check a coach code, add `?action=login&code=YOURCODE` to the end of the URL. It should show your coach name. A wrong code shows `unauthorized`.

## Part G. Changing the script later (important)

Pasting new code is **not enough**. The live web address keeps running the old version until you redeploy:

1. Paste the new `Code.gs` over the old one and click Save.
2. Click **Deploy > Manage deployments**.
3. Click the **pencil icon** on your deployment.
4. Under Version choose **New version**, then click **Deploy**.

The web address stays the same. If a change in the script needs a new permission, run `authorizeAll` again before redeploying.

## Good to know

- **Reminders** run every 15 minutes by themselves (setup installed that). Unclaimed after 30 minutes: a nudge. After 2 hours: everyone is tagged. A claimed lead with no contact logged for an hour, or a follow-up date that has passed: the owner is tagged. Check **Triggers** (clock icon on the left) to see it is listed.
- **Time zone for "today"** is Singapore (UTC+8). If you coach elsewhere, change `TZ_OFFSET_MIN` near the top of `Code.gs` (minutes from UTC), then redeploy.
- **Do not rename the column headings** on the three tabs. You may add your own extra columns and reorder them. You may edit values (for example fix a phone number) directly in the Sheet.
- **Leads tab, "Reminded Level"** is the script's memory of which reminders were sent. Do not edit it.
- **Spam protection**: a hidden form field catches simple bots, and the same phone number can submit at most 3 times an hour. Google does not tell the script who is visiting, so there is no per-visitor limit.
- A Telegram problem never stops a lead from being saved. If messages stop arriving, the lead is still in the Sheet.
- **Security note**: a coach's access code is the only thing protecting the lead list (which contains phone numbers). Treat it like a password and change it on the Coaches tab if someone leaves.
- The reminder link in Telegram messages is `SITE_URL` followed by `#lead=<id>`.
- If something fails, open **Executions** (left menu in Apps Script) to see the error and copy it to whoever is helping you.
