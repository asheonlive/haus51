const admin = require("firebase-admin");

const DATABASE_URL = "https://haus51-c591b-default-rtdb.asia-southeast1.firebasedatabase.app";
const TIME_ZONE = "Asia/Dubai";
const APP_URL = process.env.ATTENDANCE_APP_URL || "https://attendance.netlify.app/";

async function sendReminders() {
  initFirebaseAdmin();

  const now = new Date();
  const reminder = currentReminderWindow(now);
  if (!reminder) {
    console.log("No reminder window right now.");
    return;
  }

  const db = admin.database();
  const dateKey = formatDubaiDate(now);
  const employeesSnapshot = await db.ref("employees").get();
  const employees = employeesSnapshot.val() || {};
  let sent = 0;

  await Promise.all(
    Object.entries(employees).map(async ([employeeSlug, employee]) => {
      const recordSnapshot = await db.ref(`attendanceRecords/${dateKey}_${employeeSlug}`).get();
      const record = recordSnapshot.val() || {};
      if (reminder.type === "clockIn" && record.clockIn) {
        return;
      }
      if (reminder.type === "clockOut" && (!record.clockIn || record.clockOut)) {
        return;
      }

      const logRef = db.ref(`pushReminderLog/${employeeSlug}/${dateKey}/${reminder.type}`);
      const logSnapshot = await logRef.get();
      if (logSnapshot.exists()) {
        return;
      }

      const tokensSnapshot = await db.ref(`pushTokens/${employeeSlug}`).get();
      const tokenEntries = Object.entries(tokensSnapshot.val() || {});
      const tokens = tokenEntries.map(([, entry]) => entry.token).filter(Boolean);
      if (!tokens.length) {
        return;
      }

      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: {
          title: reminder.title,
          body: reminder.body
        },
        webpush: {
          fcmOptions: {
            link: APP_URL
          },
          notification: {
            icon: "/icons/icon-192.png",
            badge: "/icons/icon-192.png"
          }
        },
        data: {
          employeeSlug,
          employeeName: employee.name || employeeSlug,
          reminderType: reminder.type,
          dateKey
        }
      });

      sent += response.successCount;
      await logRef.set({
        sentAt: now.toISOString(),
        successCount: response.successCount,
        failureCount: response.failureCount,
        source: "github-actions"
      });

      await Promise.all(
        response.responses.map((result, index) => {
          if (result.success) {
            return null;
          }
          const code = result.error?.code || "";
          if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
            return db.ref(`pushTokens/${employeeSlug}/${tokenEntries[index][0]}`).remove();
          }
          console.error(`Reminder failed for ${employeeSlug}:`, result.error?.message || code);
          return null;
        })
      );
    })
  );

  console.log(`Reminder type: ${reminder.type}. Push notifications sent: ${sent}.`);
}

async function sendTestReminder(employeeSlug = "ashen") {
  initFirebaseAdmin();
  const db = admin.database();
  const tokensSnapshot = await db.ref(`pushTokens/${employeeSlug}`).get();
  const tokenEntries = Object.entries(tokensSnapshot.val() || {});
  const tokens = tokenEntries.map(([, entry]) => entry.token).filter(Boolean);
  if (!tokens.length) {
    console.log(`No push tokens saved for ${employeeSlug}.`);
    return {
      sent: 0,
      employeeSlug
    };
  }

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: "Attendance reminder test",
      body: "If you see this, closed-app notifications are working."
    },
    webpush: {
      fcmOptions: {
        link: APP_URL
      },
      notification: {
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png"
      }
    },
    data: {
      employeeSlug,
      reminderType: "test"
    }
  });

  await db.ref(`pushTestLog/${employeeSlug}/${Date.now()}`).set({
    sentAt: new Date().toISOString(),
    successCount: response.successCount,
    failureCount: response.failureCount,
    source: "aws-lambda-test"
  });

  console.log(`Test reminder sent to ${employeeSlug}. Success: ${response.successCount}. Failed: ${response.failureCount}.`);
  return {
    sent: response.successCount,
    failed: response.failureCount,
    employeeSlug
  };
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON secret.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
    databaseURL: DATABASE_URL
  });
}

function currentReminderWindow(now) {
  const parts = dubaiDateParts(now);
  const day = Number(parts.weekday);
  if (day === 7) {
    return null;
  }

  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 9 * 60 + 10 && minutes <= 9 * 60 + 30) {
    return {
      type: "clockIn",
      title: "Clock in reminder",
      body: "You have not clocked in for today."
    };
  }

  const isSaturday = day === 6;
  const clockOutStart = isSaturday ? 14 * 60 + 10 : 18 * 60 + 4;
  const clockOutEnd = isSaturday ? 14 * 60 + 30 : 18 * 60 + 30;
  if (minutes >= clockOutStart && minutes <= clockOutEnd) {
    return {
      type: "clockOut",
      title: "Clock out reminder",
      body: "You have not clocked out for today."
    };
  }

  return null;
}

function formatDubaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

function dubaiDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  }).formatToParts(date);
  const weekdayMap = {
    Sun: 7,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return {
    hour: part(parts, "hour"),
    minute: part(parts, "minute"),
    weekday: weekdayMap[part(parts, "weekday")]
  };
}

function part(parts, type) {
  return parts.find((item) => item.type === type)?.value || "";
}

module.exports = {
  sendReminders,
  sendTestReminder
};

if (require.main === module) {
  const task =
    process.env.FORCE_TEST_NOTIFICATION === "true"
      ? sendTestReminder(process.env.TEST_EMPLOYEE_SLUG || "ashen")
      : sendReminders();

  task.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
