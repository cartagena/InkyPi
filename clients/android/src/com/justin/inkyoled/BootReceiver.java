package com.justin.inkyoled;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Relaunches the dashboard after a reboot or power cut.
 *
 * IMPORTANT CAVEAT: since Android 10, apps cannot start activities from the background.
 * This receiver fires, but the activity launch may be silently dropped unless the app has
 * been granted "Display over other apps" (SYSTEM_ALERT_WINDOW), which exempts it.
 *
 * Grant it with:
 *     adb shell appops set com.justin.inkyoled SYSTEM_ALERT_WINDOW allow
 * or via Settings > Apps > Inky OLED > Display over other apps.
 *
 * Alternative that always works: set this app as the HOME launcher. Not recommended here,
 * because the tablet is also used as a normal handheld video player and a launcher with no
 * app drawer gets in the way.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "InkyOLED";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {

            try {
                Intent launch = new Intent(context, MainActivity.class);
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(launch);
                Log.i(TAG, "BootReceiver: dashboard launch requested");
            } catch (Exception e) {
                // Expected if background activity starts are blocked and the overlay
                // permission has not been granted. Log rather than crash.
                Log.w(TAG, "BootReceiver: could not start activity - "
                        + "grant SYSTEM_ALERT_WINDOW to allow background launch", e);
            }
        }
    }
}
