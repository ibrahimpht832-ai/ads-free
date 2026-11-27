package com.safefeed.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Takes picture jobs from the Facebook page, gets a small JPEG for each one,
 * hands it to the hidden face-check page and sends the verdict back.
 * Verdicts: 0 = no woman's face, 1 = woman's face, 2 = error (picture stays blurred).
 * Nothing here ever leaves the phone except downloading the picture from Facebook's own servers.
 */
final class Pipeline {

    interface Host {
        /** Ask the hidden face-check page to start job number jobId (priority = video frame). Any thread. */
        void runMl(int jobId, boolean priority);

        /** Send a verdict back to the Facebook page. Any thread. */
        void deliver(String token, int id, int verdict);
    }

    static final int OK = 0;
    static final int FEMALE = 1;
    static final int ERROR = 2;

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Mobile Safari/537.36";
    private static final int MAX_DOWNLOAD = 8 * 1024 * 1024;
    private static final int MAX_FRAME_BASE64 = 900 * 1024;
    private static final int SHRINK_TO = 640;
    private static final long JOB_TIMEOUT_SECONDS = 70;
    private static final long VIDEO_TIMEOUT_SECONDS = 6; // an old video frame is worthless
    private static final int CACHE_MAX = 4000;

    private static final class Job {
        final String token;
        final int id;
        final String key;
        final byte[] data;
        final boolean priority;

        Job(String token, int id, String key, byte[] data, boolean priority) {
            this.token = token;
            this.id = id;
            this.key = key;
            this.data = data;
            this.priority = priority;
        }
    }

    private final Host host;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final Map<Integer, Job> jobs = new ConcurrentHashMap<Integer, Job>();
    private final AtomicInteger nextJob = new AtomicInteger(1);
    private final Object lock = new Object();
    private final List<Integer> waiting = new ArrayList<Integer>();
    private final List<String> notes = new ArrayList<String>();
    private final LinkedHashMap<String, Integer> cache =
            new LinkedHashMap<String, Integer>(256, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Integer> eldest) {
                    return size() > CACHE_MAX;
                }
            };

    private volatile boolean mlReady = false;
    private volatile String mlInfo = "starting...";

    private final AtomicInteger nDownloads = new AtomicInteger();
    private final AtomicInteger nFrames = new AtomicInteger();
    private final AtomicInteger nCacheHits = new AtomicInteger();
    private final AtomicInteger nClean = new AtomicInteger();
    private final AtomicInteger nWoman = new AtomicInteger();
    private final AtomicInteger nErrors = new AtomicInteger();

    Pipeline(Host host) {
        this.host = host;
    }

    // ---------------------------------------------------------------- from the Facebook page

    /** The page could not read the picture itself, so the app downloads it. */
    void check(final String token, final int id, final String url) {
        if (!validToken(token) || url == null) {
            return;
        }
        final Uri uri = Uri.parse(url);
        if (!allowed(uri)) {
            note("blocked address: " + safeHost(uri));
            nErrors.incrementAndGet();
            host.deliver(token, id, ERROR);
            return;
        }
        final String key = cacheKey(uri);
        Integer hit;
        synchronized (cache) {
            hit = cache.get(key);
        }
        if (hit != null) {
            nCacheHits.incrementAndGet();
            host.deliver(token, id, hit.intValue());
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    nDownloads.incrementAndGet();
                    byte[] raw = download(url);
                    byte[] jpg = shrink(raw);
                    submit(new Job(token, id, key, jpg, false));
                } catch (Throwable t) {
                    nErrors.incrementAndGet();
                    note("download: " + t);
                    host.deliver(token, id, ERROR);
                }
            }
        });
    }

    /** The page already drew the picture and sent it as base64 JPEG. */
    void frame(String token, int id, String b64) {
        frame(token, id, b64, false);
    }

    /** A picture or a video frame as base64 JPEG. Video frames (priority) are checked first. */
    void frame(String token, int id, String b64, boolean priority) {
        if (!validToken(token) || b64 == null) {
            return;
        }
        nFrames.incrementAndGet();
        try {
            if (b64.length() > MAX_FRAME_BASE64) {
                throw new IOException("frame too big");
            }
            int comma = b64.indexOf(',');
            String body = (b64.startsWith("data:") && comma > 0) ? b64.substring(comma + 1) : b64;
            byte[] bytes = Base64.decode(body, Base64.DEFAULT);
            if (bytes.length < 100) {
                throw new IOException("frame too small");
            }
            submit(new Job(token, id, null, bytes, priority));
        } catch (Throwable t) {
            nErrors.incrementAndGet();
            note("frame: " + t);
            host.deliver(token, id, ERROR);
        }
    }

    // ---------------------------------------------------------------- from the face-check page

    /** The hidden page reads job data here (served at /job?id=N). */
    byte[] takeJob(int jobId) {
        Job j = jobs.get(Integer.valueOf(jobId));
        return j == null ? null : j.data;
    }

    void onMlReady(String info) {
        List<Integer> flush;
        synchronized (lock) {
            mlReady = true;
            mlInfo = "ready: " + info;
            flush = new ArrayList<Integer>(waiting);
            waiting.clear();
        }
        for (int i = 0; i < flush.size(); i++) {
            Job j = jobs.get(flush.get(i));
            if (j != null) {
                host.runMl(flush.get(i).intValue(), j.priority);
            }
        }
    }

    void onMlFail(String why) {
        mlInfo = "FAILED: " + why;
        note("ml failed: " + why);
    }

    void onMlResult(int jobId, int verdict, String info) {
        Job j = jobs.remove(Integer.valueOf(jobId));
        if (j == null) {
            return;
        }
        int v = verdict;
        if (v != OK && v != FEMALE) {
            v = ERROR;
            nErrors.incrementAndGet();
            if (info != null && info.length() > 0) {
                note("ml: " + info);
            }
        } else if (v == OK) {
            nClean.incrementAndGet();
        } else {
            nWoman.incrementAndGet();
        }
        if (j.key != null && v != ERROR) {
            synchronized (cache) {
                cache.put(j.key, Integer.valueOf(v));
            }
        }
        host.deliver(j.token, j.id, v);
    }

    // ---------------------------------------------------------------- misc

    void note(String msg) {
        String m = msg == null ? "null" : msg;
        if (m.length() > 200) {
            m = m.substring(0, 200);
        }
        synchronized (notes) {
            notes.add(m);
            while (notes.size() > 12) {
                notes.remove(0);
            }
        }
    }

    String statusText() {
        StringBuilder sb = new StringBuilder();
        sb.append("Face check: ").append(mlInfo).append('\n');
        sb.append("Waiting jobs: ").append(jobs.size()).append('\n');
        sb.append("Pictures read in page: ").append(nFrames.get()).append('\n');
        sb.append("Pictures downloaded by app: ").append(nDownloads.get())
                .append("  (remembered: ").append(nCacheHits.get()).append(")\n");
        sb.append("No woman: ").append(nClean.get())
                .append("   Woman: ").append(nWoman.get())
                .append("   Errors: ").append(nErrors.get()).append('\n');
        synchronized (notes) {
            if (!notes.isEmpty()) {
                sb.append("\nLast problems:\n");
                for (int i = 0; i < notes.size(); i++) {
                    sb.append("- ").append(notes.get(i)).append('\n');
                }
            }
        }
        return sb.toString();
    }

    void shutdown() {
        pool.shutdownNow();
        timer.shutdownNow();
    }

    private void submit(Job job) {
        final int jobId = nextJob.getAndIncrement();
        jobs.put(Integer.valueOf(jobId), job);
        timer.schedule(new Runnable() {
            @Override
            public void run() {
                expire(jobId);
            }
        }, job.priority ? VIDEO_TIMEOUT_SECONDS : JOB_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        boolean now;
        synchronized (lock) {
            now = mlReady;
            if (!now) {
                waiting.add(Integer.valueOf(jobId));
            }
        }
        if (now) {
            host.runMl(jobId, job.priority);
        }
    }

    private void expire(int jobId) {
        Job j = jobs.remove(Integer.valueOf(jobId));
        if (j != null) {
            nErrors.incrementAndGet();
            note("job timed out");
            host.deliver(j.token, j.id, ERROR);
        }
    }

    private static boolean validToken(String t) {
        if (t == null || t.length() < 4 || t.length() > 40) {
            return false;
        }
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    private static String safeHost(Uri u) {
        String h = u.getHost();
        return h == null ? "?" : h;
    }

    /** Only https pictures from Facebook's own servers. */
    static boolean allowed(Uri u) {
        if (u == null || !"https".equalsIgnoreCase(u.getScheme())) {
            return false;
        }
        String h = u.getHost();
        if (h == null) {
            return false;
        }
        h = h.toLowerCase(Locale.ROOT);
        return h.equals("fbcdn.net") || h.endsWith(".fbcdn.net")
                || h.equals("facebook.com") || h.endsWith(".facebook.com")
                || h.equals("fbsbx.com") || h.endsWith(".fbsbx.com")
                || h.equals("cdninstagram.com") || h.endsWith(".cdninstagram.com");
    }

    static String cacheKey(Uri u) {
        String stp = u.getQueryParameter("stp");
        String path = u.getPath();
        return (path == null ? "" : path) + "|" + (stp == null ? "" : stp);
    }

    private static byte[] download(String start) throws IOException {
        String cur = start;
        for (int hop = 0; hop < 4; hop++) {
            if (!allowed(Uri.parse(cur))) {
                throw new IOException("address not allowed");
            }
            HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(12000);
                c.setReadTimeout(20000);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Accept", "image/jpeg,image/webp,image/png,image/*;q=0.8");
                c.setRequestProperty("Referer", "https://m.facebook.com/");
                int code = c.getResponseCode();
                if (code >= 300 && code < 400) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null) {
                        throw new IOException("redirect without address");
                    }
                    cur = new URL(new URL(cur), loc).toString();
                    continue;
                }
                if (code != 200) {
                    throw new IOException("http " + code);
                }
                InputStream in = c.getInputStream();
                try {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
                    byte[] buf = new byte[16 * 1024];
                    int total = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_DOWNLOAD) {
                            throw new IOException("picture too big");
                        }
                        out.write(buf, 0, n);
                    }
                    return out.toByteArray();
                } finally {
                    in.close();
                }
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("too many redirects");
    }

    private static byte[] shrink(byte[] raw) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
        int w = bounds.outWidth;
        int h = bounds.outHeight;
        if (w <= 0 || h <= 0) {
            throw new IOException("not a picture");
        }
        int sample = 1;
        while (Math.max(w, h) / (sample * 2) >= SHRINK_TO) {
            sample *= 2;
        }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        Bitmap bm = BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
        if (bm == null) {
            throw new IOException("cannot decode picture");
        }
        try {
            int bw = bm.getWidth();
            int bh = bm.getHeight();
            float s = (float) SHRINK_TO / (float) Math.max(bw, bh);
            Bitmap use = bm;
            if (s < 1f) {
                use = Bitmap.createScaledBitmap(bm, Math.max(1, Math.round(bw * s)),
                        Math.max(1, Math.round(bh * s)), true);
            }
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
                use.compress(Bitmap.CompressFormat.JPEG, 88, out);
                return out.toByteArray();
            } finally {
                if (use != bm) {
                    use.recycle();
                }
            }
        } finally {
            bm.recycle();
        }
    }
}
