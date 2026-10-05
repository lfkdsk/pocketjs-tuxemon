// Included into a scratch copy of PocketJS's desktop host by
// bench-g6-quickjs.sh. It times the real rquickjs Guest + UiSurface while
// replaying the maintained G6 journey; no Bun/JSC execution is measured.
#[cfg(test)]
mod g6_quickjs_bench {
    use super::*;
    use pocket_mod::qjs::Function;
    use serde::Deserialize;
    use std::collections::{HashMap, HashSet};
    use std::ffi::CString;
    use std::fmt::Write as _;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use std::time::Instant;

    const BENCH_APP_ID: &str = "dev.lfkdsk.pocket-tuxemon-bench";
    const BENCH_TICK: Duration = Duration::from_nanos(1_000_000_000 / 60);

    /// GC policy exercised by the benchmark. The normal command follows the
    /// production desktop host; G6_GC_MODE=auto restores QuickJS's default
    /// allocation-triggered collector for an explicit comparison run.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum GcMode {
        Idle,
        Auto,
    }

    impl GcMode {
        fn from_env() -> Self {
            match std::env::var("G6_GC_MODE").as_deref() {
                Err(std::env::VarError::NotPresent) | Ok("") | Ok("idle") => Self::Idle,
                Ok("auto") => Self::Auto,
                Ok(value) => panic!(
                    "G6_GC_MODE must be 'idle' (production default) or 'auto', got {value:?}"
                ),
                Err(error) => panic!("G6_GC_MODE is not valid Unicode: {error}"),
            }
        }

        fn label(self) -> &'static str {
            match self {
                Self::Idle => "idle",
                Self::Auto => "auto",
            }
        }

        fn guest(self) -> Result<Guest> {
            match self {
                Self::Idle => Guest::new_with_idle_gc(pocket_mod::IdleGcConfig::default()),
                Self::Auto => Guest::new(),
            }
        }
    }

    /// Cumulative QuickJS allocation counters. `malloc_count` in
    /// JSMemoryUsage is the LIVE count (decremented on free), so it cannot
    /// measure an allocation rate; this counting allocator wraps the stock
    /// RustAllocator and counts every alloc/calloc/realloc event and the
    /// requested bytes. Enabled with G6_COUNT_ALLOCS=1 so the journey and
    /// map-first-visit tests keep the default allocator.
    static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);
    static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

    fn alloc_counts() -> (u64, u64) {
        (
            ALLOC_COUNT.load(Ordering::Relaxed),
            ALLOC_BYTES.load(Ordering::Relaxed),
        )
    }

    struct CountingAllocator {
        inner: pocket_mod::qjs::allocator::RustAllocator,
    }

    impl CountingAllocator {
        fn new() -> Self {
            Self {
                inner: pocket_mod::qjs::allocator::RustAllocator,
            }
        }
    }

    unsafe impl pocket_mod::qjs::allocator::Allocator for CountingAllocator {
        fn alloc(&mut self, size: usize) -> *mut u8 {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(size as u64, Ordering::Relaxed);
            self.inner.alloc(size)
        }
        fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(count as u64 * size as u64, Ordering::Relaxed);
            self.inner.calloc(count, size)
        }
        unsafe fn dealloc(&mut self, ptr: *mut u8) {
            unsafe { self.inner.dealloc(ptr) }
        }
        unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
            unsafe { self.inner.realloc(ptr, new_size) }
        }
        unsafe fn usable_size(ptr: *mut u8) -> usize
        where
            Self: Sized,
        {
            unsafe { pocket_mod::qjs::allocator::RustAllocator::usable_size(ptr) }
        }
    }

    /// Per-frame timing source.  The 50 ms frame budget asserts on THREAD CPU
    /// time, not wall clock: on a shared host the bench thread is routinely
    /// descheduled for >100 ms, which made the wall-
    /// clock max assertion flaky even though the frame did no work during
    /// the gap.  `CLOCK_THREAD_CPUTIME_ID` advances only while the calling
    /// thread runs, so a descheduled frame shows its real (small) CPU cost
    /// while a frame that genuinely burns >50 ms of CPU still trips the
    /// assertion.  Wall clock is still measured and reported everywhere.
    #[cfg(target_os = "linux")]
    mod thread_cpu {
        #[repr(C)]
        struct Timespec {
            sec: i64,
            nsec: i64,
        }
        unsafe extern "C" {
            fn clock_gettime(clk_id: i32, tp: *mut Timespec) -> i32;
        }
        const CLOCK_THREAD_CPUTIME_ID: i32 = 3;
        pub fn now_ms() -> f64 {
            let mut tp = Timespec { sec: 0, nsec: 0 };
            unsafe {
                clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut tp);
            }
            tp.sec as f64 * 1_000.0 + tp.nsec as f64 / 1_000_000.0
        }
        pub const AVAILABLE: bool = true;
    }

    #[cfg(not(target_os = "linux"))]
    mod thread_cpu {
        pub fn now_ms() -> f64 {
            // Non-Linux fallback: the host crate has no libc dependency, so
            // fall back to a monotonic wall-clock delta.  The assertion is
            // then as noisy as before on these platforms; the Linux bench
            // (the acceptance host) uses true thread CPU time.
            use std::sync::OnceLock;
            static EPOCH: OnceLock<std::time::Instant> = OnceLock::new();
            let epoch = EPOCH.get_or_init(std::time::Instant::now);
            epoch.elapsed().as_secs_f64() * 1_000.0
        }
        pub const AVAILABLE: bool = false;
    }

    /// Optional CPU-work injection for the red-test: when
    /// G6_INJECT_CPU_FRAME names the current frame, burn G6_INJECT_CPU_MS
    /// milliseconds of real thread CPU time in a busy loop.  This makes the
    /// frame's CPU time exceed the 50 ms budget, proving the assertion
    /// still catches genuinely expensive frames (battle entry/exit, etc.).
    fn maybe_inject_cpu(frame: usize) {
        let Ok(target) = std::env::var("G6_INJECT_CPU_FRAME") else {
            return;
        };
        if target.parse::<usize>().ok() != Some(frame) {
            return;
        }
        let ms: f64 = std::env::var("G6_INJECT_CPU_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(80.0);
        let start = thread_cpu::now_ms();
        while thread_cpu::now_ms() - start < ms {
            std::hint::black_box(0u64.wrapping_add(1));
        }
    }

    /// Complement to maybe_inject_cpu: when G6_INJECT_SLEEP_FRAME names the
    /// current frame, sleep G6_INJECT_SLEEP_MS milliseconds.  This
    /// deschedules the thread (a >100 ms scheduling gap): the
    /// wall-clock duration spikes but the thread CPU time does not, so the
    /// CPU-time budget still passes while the old wall-clock budget would
    /// have failed.  Proves the assertion is immune to scheduling gaps.
    fn maybe_inject_sleep(frame: usize) {
        let Ok(target) = std::env::var("G6_INJECT_SLEEP_FRAME") else {
            return;
        };
        if target.parse::<usize>().ok() != Some(frame) {
            return;
        }
        let ms: u64 = std::env::var("G6_INJECT_SLEEP_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(120);
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    #[derive(Deserialize)]
    struct Journey {
        masks: Vec<u32>,
        #[serde(default)]
        battles: Vec<JourneyBattle>,
        #[serde(default)]
        maps: Vec<JourneyMap>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct JourneyBattle {
        start_frame: usize,
        end_frame: usize,
    }

    #[derive(Deserialize)]
    struct JourneyMap {
        frame: usize,
        map: String,
    }

    /// One `ui/gp1-marks.ts` checkpoint: `at` is a
    /// `Date.now()` epoch-ms timestamp recorded by the real production
    /// bundle's own module graph, not a synthetic probe.
    #[derive(Deserialize)]
    struct Gp1Mark {
        name: String,
        at: f64,
    }

    /// GP1: the exact marker sequence main.tsx's module
    /// graph must produce. A missing/renamed/reordered mark is a real bundle
    /// regression (a wrapper stopped importing what it used to, or a new
    /// stage was inserted without updating this list) and must fail the
    /// bench, not print a silently-ignored partial table.
    const EXPECTED_GP1_MARKS: [&str; 6] = [
        "module-start",
        "engine",
        "json-literals",
        "language-data",
        "battle-registration",
        "mount",
    ];

    fn assert_gp1_marks(marks: &[Gp1Mark]) {
        let names: Vec<&str> = marks.iter().map(|mark| mark.name.as_str()).collect();
        assert_eq!(
            names,
            EXPECTED_GP1_MARKS.to_vec(),
            "gp1 marks must be exactly {EXPECTED_GP1_MARKS:?} in that order",
        );
        for pair in marks.windows(2) {
            assert!(
                pair[1].at >= pair[0].at,
                "gp1 marks must be non-decreasing: {} (at {}) came before {} (at {})",
                pair[0].name,
                pair[0].at,
                pair[1].name,
                pair[1].at,
            );
        }
    }

    /// GP1: `Runtime::boot`'s stages up to and including
    /// the bundle eval, timed at their real host-call boundaries instead of
    /// reconstructed from `ui/gp1-marks.ts` deltas. `host_init_ms` covers
    /// pak/source read plus surface/fs mount (no JS runs yet); `compile_ms`
    /// and `eval_ms` are the two halves of what `Guest::eval` normally does
    /// in one call (see `gp1_eval_staged`); `host_finish_ms` is the small
    /// tail after eval (frame-handler check, initial `svc_push`, wiring).
    struct StageTimes {
        host_init_ms: f64,
        compile_ms: f64,
        eval_ms: f64,
        host_finish_ms: f64,
    }

    /// GP1: `pocket_mod::Guest::eval` (vendor/) does one
    /// `JS_Eval` call that both compiles and runs the bundle's top level, so
    /// no existing pocket-mod API can time those halves separately. This
    /// duplicates that one call via the raw quickjs FFI (already used by
    /// `qjs_memory` in this file) instead of modifying pocket-mod: a
    /// `JS_EVAL_FLAG_COMPILE_ONLY` pass produces bytecode without running
    /// anything (real parse + codegen time, not a guess), then
    /// `JS_EvalFunction` runs it (real "everything the bundle's top level
    /// does before `mount()` returns" time — including solid-js's own
    /// module init, which runs before `ui/gp1-marks.ts`'s first mark and so
    /// was invisible to the mark-delta table alone; the old report
    /// attributed that stretch to nothing).
    /// `JS_EvalFunction` always consumes its `fun_obj` argument (quickjs.c
    /// `JS_EvalFunctionInternal`), so the compiled value must not be freed
    /// after a successful compile — only on the compile-failure path, where
    /// `JS_EvalFunction` is never called.
    fn gp1_eval_staged(guest: &Guest, label: &str, source: &str) -> Result<(f64, f64)> {
        use pocket_mod::qjs::qjs as ffi;
        let c_source = CString::new(source)
            .map_err(|_| anyhow!("pocket-mod: bundle source has an embedded NUL byte"))?;
        let c_label = CString::new(label)
            .map_err(|_| anyhow!("pocket-mod: bundle label has an embedded NUL byte"))?;
        let source_len = c_source.as_bytes().len();
        let timings = guest.with(|ctx| -> Result<(f64, f64)> {
            let raw = ctx.as_raw().as_ptr();
            unsafe {
                let compile_start = Instant::now();
                let compiled = ffi::JS_Eval(
                    raw,
                    c_source.as_ptr(),
                    source_len as u64,
                    c_label.as_ptr(),
                    (ffi::JS_EVAL_TYPE_GLOBAL | ffi::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
                );
                let compile_ms = compile_start.elapsed().as_secs_f64() * 1_000.0;
                if compiled.tag == ffi::JS_TAG_EXCEPTION as i64 {
                    ffi::JS_FreeValue(raw, compiled);
                    let error = pocket_mod::qjs::CaughtError::from_error(
                        &ctx,
                        pocket_mod::qjs::Error::Exception,
                    );
                    return Err(anyhow!("pocket-mod: compiling '{label}' failed: {error}"));
                }
                let eval_start = Instant::now();
                let result = ffi::JS_EvalFunction(raw, compiled);
                let eval_ms = eval_start.elapsed().as_secs_f64() * 1_000.0;
                if result.tag == ffi::JS_TAG_EXCEPTION as i64 {
                    ffi::JS_FreeValue(raw, result);
                    let error = pocket_mod::qjs::CaughtError::from_error(
                        &ctx,
                        pocket_mod::qjs::Error::Exception,
                    );
                    return Err(anyhow!("pocket-mod: evaluating '{label}' failed: {error}"));
                }
                ffi::JS_FreeValue(raw, result);
                Ok((compile_ms, eval_ms))
            }
        })?;
        guest.drain_jobs();
        Ok(timings)
    }

    #[test]
    fn staged_eval_reports_javascript_message_and_stack() {
        let guest = Guest::new().unwrap();
        let error = gp1_eval_staged(
            &guest,
            "diagnostic-probe",
            "function explode() { throw new Error('staged-eval sentinel'); } explode();",
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("evaluating 'diagnostic-probe' failed"),
            "{error}"
        );
        assert!(error.contains("staged-eval sentinel"), "{error}");
        assert!(error.contains("explode"), "{error}");
    }

    /// GP1: a copy of `Runtime::boot`
    /// (vendor/pocket-rpgkit/vendor/pocketjs/hosts/desktop/src/main.rs)
    /// with the single `guest.eval(...)` call replaced by
    /// `gp1_eval_staged` so the compile/eval split above can be timed
    /// inside the exact same realm/surfaces/fs-mount the production 250 ms
    /// budget boots against. `include!` splices this file into main.rs's
    /// own module, so `Runtime`'s private fields and `boot`'s private
    /// helpers (`resolve_asset`, `text_worker`, `HOST_ID`, `HOST_ABI`,
    /// `epoch_ms`, `fs::*`, `AppSupervisor::new`) are directly reachable
    /// here without editing main.rs itself — this is a benchmark-only
    /// duplicate, not a vendor/ change; if `Runtime::boot` changes shape,
    /// this needs re-syncing by hand.
    fn boot_staged(args: Args) -> Result<(Runtime, StageTimes)> {
        if args.native_text {
            return Err(anyhow!(
                "text.layout.native is unavailable; use the portable text offload capability"
            ));
        }
        let host_init_start = Instant::now();
        let pak = std::fs::read(resolve_asset(args.pak.clone(), &args.app, "pak")?)?;
        let source = std::fs::read_to_string(resolve_asset(args.js.clone(), &args.app, "js")?)?;
        let surface = UiSurface::new_with_density(
            (args.viewport.0 as f32, args.viewport.1 as f32),
            args.density,
        );
        surface.set_identity(HOST_ID, HOST_ABI);
        surface.set_tick_rate(60);
        surface.set_svc_allowlist(args.companions.clone());
        surface.feed_pak(&pak);
        let audio_host = audio::AudioHost::new(
            1 + args
                .system
                .as_ref()
                .map_or(0, |system| system.applications.len()),
        );
        let supervisor = AppSupervisor::new(
            args.system.as_ref(),
            &surface,
            args.data_root.clone(),
            &audio_host,
        )?;
        let count_allocs = std::env::var("G6_COUNT_ALLOCS").is_ok();
        // The diagnostic counting allocator predates the production idle-GC
        // allocator and cannot be composed with it. Allocation probes run in
        // explicit auto mode; ordinary benchmark runs exercise idle GC.
        let gc_mode = if count_allocs {
            GcMode::Auto
        } else {
            GcMode::from_env()
        };
        let guest = if count_allocs {
            Guest::new_with_alloc(CountingAllocator::new())?
        } else {
            gc_mode.guest()?
        };
        surface.mount(&guest)?;
        let offload = text_worker(pak);
        offload.mount(&guest)?;
        let app_id = args.app_id.clone().unwrap_or_else(|| args.app.clone());
        let fs_roots = fs::data_roots(args.data_root.as_deref(), &app_id)?;
        let fs_mount = fs::mount_fs(&guest, &fs_roots)?;
        let audio = audio::AudioSurface::new(audio_host.client(0));
        audio.mount(&guest)?;
        // Journey and performance fixtures must not inherit the machine wall
        // clock. Install the same fixed civil time used by the Bun and web
        // harnesses before the application bundle is evaluated.
        guest.eval(
            "g6-fixed-clock",
            "globalThis.__pocketTuxemonInitialCivilTime={year:2024,month:6,day:15,hour:9,minute:0};",
        )?;
        // The world-cache stress test opts into the game's default-off
        // production diagnostics hook before bundle evaluation. Ordinary
        // journey and release launches do not create the object or callbacks.
        if std::env::var("G6_WORLD_CACHE_STRESS").is_ok() {
            guest.eval(
                "g6-world-cache-diagnostics",
                "globalThis.__pocketTuxemonWorldDiagnostics={};",
            )?;
        }
        // Optional weather override for particle-overlay cost measurement.
        if let Ok(slug) = std::env::var("G6_WEATHER") {
            guest.eval(
                "g6-fixed-weather",
                &format!(
                    "globalThis.__pocketTuxemonInitialWeather={{slug:{}}};",
                    serde_json::to_string(&slug).unwrap()
                ),
            )?;
        }
        // Optional language override so the zh_CN smoke tape can be replayed
        // on the QuickJS host (which has no URL param, localStorage or fs).
        if let Ok(lang) = std::env::var("G6_LANG") {
            guest.eval(
                "g6-lang",
                &format!("globalThis.__pocketTuxemonLang={};", serde_json::to_string(&lang).unwrap()),
            )?;
        }
        // Allocation-regression switch: skip mounting the weather overlay
        // entirely so the mem walk can diff overlay on/off on one build.
        if std::env::var("G6_WEATHER_OVERLAY_OFF").is_ok() {
            guest.eval(
                "g6-weather-overlay-off",
                "globalThis.__pocketTuxemonWeatherOverlay=false;",
            )?;
        }
        // Allocation-regression switch: mount the overlay but make its frame
        // handler a no-op, so the mem walk diffs frame-handler cost without
        // mount-time allocations changing the heap between runs.
        if std::env::var("G6_WEATHER_OVERLAY_NO_FRAME").is_ok() {
            guest.eval(
                "g6-weather-overlay-no-frame",
                "globalThis.__pocketTuxemonWeatherOverlayNoFrame=true;",
            )?;
        }
        let audio = audio::AudioSurface::new(audio_host.client(0));
        audio.mount(&guest)?;
        let host_init_ms = host_init_start.elapsed().as_secs_f64() * 1_000.0;

        let (compile_ms, eval_ms) = gp1_eval_staged(&guest, &args.app, &source)?;

        let host_finish_start = Instant::now();
        if !guest.has_frame() {
            return Err(anyhow!("bundle installed no frame handler"));
        }
        // Match Runtime::boot exactly: bundle evaluation is unbounded, then
        // the hard cap is based on the fully booted heap before frame zero.
        if gc_mode == GcMode::Idle && !guest.arm_idle_gc() {
            return Err(anyhow!(
                "idle-GC guest was not armed after bundle evaluation"
            ));
        }
        surface.svc_push(
            json!({"t":"hello","w":args.viewport.0,"h":args.viewport.1,"epoch":epoch_ms()})
                .to_string(),
        );
        if let Some(file) = &args.file
            && let Ok(text) = std::fs::read_to_string(file)
        {
            surface.svc_push(json!({"t":"load","text":text}).to_string());
        }
        let wire = args
            .svc_connect
            .clone()
            .map(|addr| net::SvcWire::spawn(addr, args.app.clone()));
        let host_finish_ms = host_finish_start.elapsed().as_secs_f64() * 1_000.0;
        let runtime = Runtime {
            viewport: args.viewport,
            script: args.script.clone(),
            args,
            surface,
            guest,
            supervisor,
            offload,
            _fs: fs_mount,
            audio,
            _audio_host: audio_host,
            ticks: 0,
            buttons: 0,
            script_buttons: 0,
            script_mouse: false,
            click_edge: false,
            mouse_down: false,
            wire,
        };
        Ok((
            runtime,
            StageTimes {
                host_init_ms,
                compile_ms,
                eval_ms,
                host_finish_ms,
            },
        ))
    }

    #[derive(Deserialize)]
    struct MapMeta {
        id: String,
        entry: String,
        width: usize,
        height: usize,
    }

    struct MapSample {
        meta: MapMeta,
        bytes: u64,
        read_parse_ms: f64,
        validate_ms: f64,
        world_compile_ms: f64,
        passage_compile_ms: f64,
        commit_ms: f64,
        total_ms: f64,
    }

    #[derive(Clone, Copy, Default)]
    struct StructuralOps {
        create: u64,
        destroy: u64,
        insert: u64,
        remove: u64,
    }

    impl StructuralOps {
        fn total(self) -> u64 {
            self.create + self.destroy + self.insert + self.remove
        }
    }

    #[derive(Clone)]
    struct FrameProfilePoint {
        stage: String,
        wall_ms: f64,
        cpu_ms: f64,
    }

    #[derive(Clone)]
    struct Sample {
        frame: usize,
        map: String,
        class: String,
        temperature: &'static str,
        moving: bool,
        fade: bool,
        battle: bool,
        battle_event: Option<String>,
        modal: Option<String>,
        js_ms: f64,
        core_ms: f64,
        draw_ms: f64,
        /// Thread CPU time for the same three segments.  The 50 ms frame
        /// budget asserts on these, not on the wall-clock *_ms fields, so a
        /// descheduling gap does not trip the budget.
        js_cpu_ms: f64,
        core_cpu_ms: f64,
        draw_cpu_ms: f64,
        draw_sampled: bool,
        /// Boundary collection after this tick. It is outside js/core/draw.
        gc_ms: f64,
        /// True when QuickJS changed its threshold during the product turn.
        in_tick_gc: bool,
        /// Constant-time counting-allocator size in idle mode; zero in auto.
        heap_bytes: usize,
        structural: StructuralOps,
        // G6_BATTLE_BUCKETS: per-frame battle shape for the p95 explanation.
        player_party: u8,
        enemy_party: u8,
        menu_mode: Option<String>,
        // G6_HANDOFF_BUCKETS: actual live seamless state, even when the fast
        // journey path uses frozen map/battle metadata for the older buckets.
        live_map: String,
        live_fade: bool,
        handoff: Option<HandoffFrame>,
        profile: Vec<FrameProfilePoint>,
    }

    struct RawFrameProfilePoint {
        stage: String,
        wall: Instant,
        cpu_ms: f64,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HandoffFrame {
        source_map_id: String,
        target_map_id: String,
        phase: usize,
        total_ticks: usize,
    }

    #[derive(Deserialize)]
    struct HandoffObservation {
        map: String,
        fade: bool,
        handoff: Option<HandoffFrame>,
    }

    struct Bench {
        rt: Runtime,
        gc_mode: GcMode,
        sample_structural: bool,
        hash_every: usize,
        battle_buckets: bool,
        handoff_buckets: bool,
        profile_frames: HashSet<usize>,
        profile_marks: Arc<Mutex<Vec<RawFrameProfilePoint>>>,
        profile_capture: Arc<AtomicBool>,
    }

    impl Bench {
        fn string(&self, source: &str) -> String {
            self.rt
                .guest
                .with(|ctx| match ctx.eval::<String, _>(source) {
                    Ok(value) => value,
                    Err(error) => {
                        let message = ctx
                            .catch()
                            .as_exception()
                            .map(|exception| format!("{:?}", exception.message()));
                        panic!("QuickJS eval failed: {error} {message:?} source={source}")
                    }
                })
        }

        fn boolean(&self, source: &str) -> bool {
            self.rt.guest.with(|ctx| match ctx.eval::<bool, _>(source) {
                Ok(value) => value,
                Err(error) => {
                    let message = ctx
                        .catch()
                        .as_exception()
                        .map(|exception| format!("{:?}", exception.message()));
                    panic!("QuickJS eval failed: {error} {message:?} source={source}")
                }
            })
        }

        fn unit(&self, source: &str) {
            self.rt
                .guest
                .with(|ctx| ctx.eval::<(), _>(source).expect("QuickJS unit eval"));
        }

        fn install_structural_counter(&self) {
            self.unit(
                r#"
                globalThis.__g6BattleOps = {createNode:0,destroyNode:0,insertBefore:0,removeChild:0};
                for (const name of ["createNode","destroyNode","insertBefore","removeChild"]) {
                  const original = globalThis.ui[name];
                  globalThis.ui[name] = function(...args) {
                    globalThis.__g6BattleOps[name]++;
                    return original.apply(globalThis.ui, args);
                  };
                }
                "#,
            );
        }

        fn reset_structural_counter(&self) {
            self.unit(
                "for(const name of Object.keys(globalThis.__g6BattleOps))globalThis.__g6BattleOps[name]=0",
            );
        }

        fn structural_ops(&self) -> StructuralOps {
            let values: (u64, u64, u64, u64) = serde_json::from_str(&self.string(
                "JSON.stringify([__g6BattleOps.createNode,__g6BattleOps.destroyNode,__g6BattleOps.insertBefore,__g6BattleOps.removeChild])",
            ))
            .expect("G6 structural-op tuple");
            StructuralOps {
                create: values.0,
                destroy: values.1,
                insert: values.2,
                remove: values.3,
            }
        }

        fn state(&self) -> (String, bool, bool, bool, Option<String>, Option<String>) {
            serde_json::from_str(&self.string(
                r#"(()=>{const s=globalThis.__rpgSessionState;const b=s.scene?.kind==='battle'?s.scene.state:null;return JSON.stringify([s.mapId,!!s.move.moving,!!s.fade,!!b,b?.battle?.events?.[b.eventCursor]?.type??null,s.interp?.modal?.kind??null])})()"#,
            ))
            .expect("G6 state tuple")
        }

        /// Richer per-frame battle shape for the p95 explanation: party sizes
        /// (full party, active+reserve) and the battle menu mode.  Read AFTER
        /// the frame timing points (same as `state`), so the extra eval never
        /// skews js_ms/core_ms/draw_ms.
        fn state_rich(
            &self,
        ) -> (
            String,
            bool,
            bool,
            bool,
            Option<String>,
            u8,
            u8,
            Option<String>,
            Option<String>,
        ) {
            serde_json::from_str(&self.string(
                r#"(()=>{const s=globalThis.__rpgSessionState;const b=s.scene?.kind==='battle'?s.scene.state:null;return JSON.stringify([s.mapId,!!s.move.moving,!!s.fade,!!b,b?.battle?.events?.[b.eventCursor]?.type??null,b?b.battle.parties[0].length:0,b?b.battle.parties[1].length:0,b?b.menuMode:null,s.interp?.modal?.kind??null])})()"#,
            ))
            .expect("G6 rich state tuple")
        }

        fn install_frame_profiler(&self) {
            if self.profile_frames.is_empty() {
                return;
            }
            let marks = self.profile_marks.clone();
            let capture = self.profile_capture.clone();
            self.rt.guest.with(|ctx| {
                let mark = Function::new(ctx.clone(), move |stage: String| {
                    if !capture.load(Ordering::Relaxed) {
                        return;
                    }
                    marks.lock().unwrap().push(RawFrameProfilePoint {
                        stage,
                        wall: Instant::now(),
                        cpu_ms: thread_cpu::now_ms(),
                    });
                })
                .unwrap();
                ctx.globals().set("__rpgkitFrameProfileMark", mark).unwrap();
            });
        }

        fn handoff_state(&self) -> HandoffObservation {
            serde_json::from_str(&self.string(
                r#"(()=>{const s=globalThis.__rpgSessionState;return JSON.stringify({map:s.mapId,fade:!!s.fade,handoff:s.handoff??null})})()"#,
            ))
            .expect("G6 handoff observation")
        }

        fn frame(
            &mut self,
            frame: usize,
            mask: u32,
            frozen: Option<(&str, bool)>,
            force_hash: bool,
        ) -> Sample {
            if self.sample_structural {
                self.reset_structural_counter();
            }
            let capture_profile = self.profile_frames.contains(&frame);
            if capture_profile {
                self.profile_marks.lock().unwrap().clear();
            }
            self.profile_capture
                .store(capture_profile, Ordering::Relaxed);
            // The desktop host's boundary budget starts before all per-tick
            // audio/offload work, so keep a separate whole-tick timestamp
            // while preserving the existing js/core segment timings.
            let work_start = Instant::now();
            self.rt.buttons = mask;
            self.rt._audio_host.begin_tick();
            self.rt.audio.begin_tick();
            self.rt.offload.begin_frame();
            let threshold_before = gc_threshold(&self.rt.guest);
            let a = Instant::now();
            let a_cpu = thread_cpu::now_ms();
            // Injection point: inside the measured region so the burned CPU
            // time lands in js_cpu_ms, exactly as a slower QuickJS frame would.
            maybe_inject_cpu(frame);
            // Sleep injection: a descheduling gap inflates the wall-clock
            // segment but not the CPU segment, so the CPU-time budget is
            // immune to it.
            maybe_inject_sleep(frame);
            self.rt.guest.frame(mask).expect("QuickJS frame");
            self.profile_capture.store(false, Ordering::Relaxed);
            let b = Instant::now();
            let b_cpu = thread_cpu::now_ms();
            self.rt.surface.tick();
            let c = Instant::now();
            let c_cpu = thread_cpu::now_ms();
            for (id, error) in self
                .rt
                .supervisor
                .sync(&self.rt.surface)
                .into_iter()
                .chain(self.rt.supervisor.tick())
            {
                panic!("AppInstance {id}: {error}");
            }
            let _ = self.rt.surface.svc_drain();
            self.rt.ticks += 1;
            let draw_sampled = force_hash || self.hash_every <= 1 || frame % self.hash_every == 0;
            if draw_sampled {
                let _ = self.rt.hash();
            }
            let d = Instant::now();
            let d_cpu = thread_cpu::now_ms();
            let in_tick_gc = gc_threshold(&self.rt.guest) != threshold_before;
            // The idle guest exposes this in O(1); auto mode deliberately
            // avoids JS_ComputeMemoryUsage in the hot path.
            let heap_bytes = self.rt.guest.heap_bytes().unwrap_or(0);
            let budget = pocket_mod::IdleBudget {
                remaining: BENCH_TICK.saturating_sub(d.duration_since(work_start)),
                period: BENCH_TICK,
            };
            let gc_ms = match self.rt.guest.idle_gc(Some(budget)) {
                pocket_mod::IdleGcOutcome::Collected(pause) => pause.as_secs_f64() * 1_000.0,
                _ => 0.0,
            };
            let profile = if capture_profile {
                self.profile_marks
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|mark| FrameProfilePoint {
                        stage: mark.stage.clone(),
                        wall_ms: mark.wall.duration_since(a).as_secs_f64() * 1_000.0,
                        cpu_ms: mark.cpu_ms - a_cpu,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let (
                map,
                moving,
                fade,
                battle,
                battle_event,
                player_party,
                enemy_party,
                menu_mode,
                modal,
            ) = if self.battle_buckets {
                let rich = self.state_rich();
                match frozen {
                    Some((fmap, fbattle)) => (
                        fmap.to_owned(),
                        rich.1,
                        rich.2,
                        fbattle,
                        rich.4,
                        rich.5,
                        rich.6,
                        rich.7,
                        rich.8,
                    ),
                    None => rich,
                }
            } else {
                let (map, moving, fade, battle, battle_event, modal) = match frozen {
                    Some((map, battle)) => {
                        let live = self.state();
                        (map.to_owned(), false, false, battle, live.4, live.5)
                    }
                    None => self.state(),
                };
                (map, moving, fade, battle, battle_event, 0, 0, None, modal)
            };
            // This eval is deliberately after all timing points. It neither
            // inflates the phase sample nor trusts fast-tape map metadata:
            // handoff completeness is proven against the live reducer state.
            // Long-tape benches restrict it to forced framebuffer windows
            // around map checkpoints, which cover phase 0..7 plus landing
            // without allocating a JSON probe on every unrelated frame.
            let handoff_observation =
                (self.handoff_buckets && force_hash).then(|| self.handoff_state());
            let live_map = handoff_observation
                .as_ref()
                .map(|observation| observation.map.clone())
                .unwrap_or_else(|| map.clone());
            let live_fade = handoff_observation
                .as_ref()
                .map(|observation| observation.fade)
                .unwrap_or(fade);
            let handoff = handoff_observation.and_then(|observation| observation.handoff);
            let structural = if self.sample_structural {
                self.structural_ops()
            } else {
                StructuralOps::default()
            };
            Sample {
                frame,
                map,
                class: "unclassified".into(),
                temperature: "hot",
                moving,
                fade,
                battle,
                battle_event,
                modal,
                js_ms: (b - a).as_secs_f64() * 1_000.0,
                core_ms: (c - b).as_secs_f64() * 1_000.0,
                draw_ms: (d - c).as_secs_f64() * 1_000.0,
                js_cpu_ms: b_cpu - a_cpu,
                core_cpu_ms: c_cpu - b_cpu,
                draw_cpu_ms: d_cpu - c_cpu,
                draw_sampled,
                gc_ms,
                in_tick_gc,
                heap_bytes,
                structural,
                player_party,
                enemy_party,
                menu_mode,
                live_map,
                live_fade,
                handoff,
                profile,
            }
        }
    }

    fn gc_threshold(guest: &Guest) -> usize {
        guest.with(|ctx| unsafe {
            pocket_mod::qjs::qjs::JS_GetGCThreshold(pocket_mod::qjs::qjs::JS_GetRuntime(
                ctx.as_raw().as_ptr(),
            )) as usize
        })
    }

    fn qjs_memory(guest: &Guest) -> (i64, i64, i64) {
        guest.with(|ctx| unsafe {
            let runtime = pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            let mut usage: pocket_mod::qjs::qjs::JSMemoryUsage = std::mem::zeroed();
            pocket_mod::qjs::qjs::JS_ComputeMemoryUsage(runtime, &mut usage);
            (usage.memory_used_size, usage.malloc_size, usage.obj_count)
        })
    }

    /// Cumulative allocation count and current live malloc bytes. Both are
    /// O(1) fields of JSMallocState (JS_ComputeMemoryUsage reads them
    /// directly); the heap walk the same call performs for the other
    /// JSMemoryUsage fields is harmless for a before/after probe.
    fn qjs_malloc_stats(guest: &Guest) -> (i64, i64) {
        guest.with(|ctx| unsafe {
            let runtime = pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            let mut usage: pocket_mod::qjs::qjs::JSMemoryUsage = std::mem::zeroed();
            pocket_mod::qjs::qjs::JS_ComputeMemoryUsage(runtime, &mut usage);
            (usage.malloc_count, usage.malloc_size)
        })
    }

    /// A threshold transition is a coarse GC signal, not an exact count:
    /// JS_GetGCThreshold can stay flat across a JS_RunGC cycle (the fix-3
    /// review's precise JS_RunGC counter observed a cycle GC with no
    /// threshold change). QuickJS exposes no GC hook, so exact GC counting
    /// requires instrumenting JS_RunGC in a temporary engine copy.
    fn qjs_gc_threshold(guest: &Guest) -> u64 {
        guest.with(|ctx| unsafe {
            let runtime = pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            pocket_mod::qjs::qjs::JS_GetGCThreshold(runtime) as u64
        })
    }

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn frame_profile_config() -> (
        HashSet<usize>,
        Arc<Mutex<Vec<RawFrameProfilePoint>>>,
        Arc<AtomicBool>,
    ) {
        let frames = std::env::var("G6_PROFILE_FRAMES")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .filter(|item| !item.is_empty())
                    .map(|item| {
                        item.parse::<usize>().unwrap_or_else(|_| {
                            panic!("G6_PROFILE_FRAMES must be comma-separated frame numbers, got {item:?}")
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        (
            frames,
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(AtomicBool::new(false)),
        )
    }

    fn report_temperature(viewport: &str, label: &str, samples: &[Sample]) {
        for temperature in ["cold", "hot"] {
            let selected: Vec<&Sample> = samples
                .iter()
                .filter(|sample| sample.temperature == temperature)
                .collect();
            if selected.is_empty() {
                continue;
            }
            let mut qjs_core: Vec<f64> = selected
                .iter()
                .map(|sample| sample.js_cpu_ms + sample.core_cpu_ms)
                .collect();
            qjs_core.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let worst = selected
                .iter()
                .max_by(|a, b| {
                    (a.js_cpu_ms + a.core_cpu_ms)
                        .partial_cmp(&(b.js_cpu_ms + b.core_cpu_ms))
                        .unwrap()
                })
                .unwrap();
            println!(
                "TEMP_CASE viewport={viewport} kind={label} temperature={temperature} n={} qjs_core_cpu_p95={:.3}ms qjs_core_cpu_max={:.3}ms worst=f{}:{} class={}",
                selected.len(),
                percentile(&qjs_core, 0.95),
                qjs_core[qjs_core.len() - 1],
                worst.frame,
                worst.map,
                worst.class,
            );
        }
    }

    fn format_frame_profile(sample: &Sample) -> String {
        sample
            .profile
            .iter()
            .map(|point| format!("{}@{:.3}/{:.3}", point.stage, point.wall_ms, point.cpu_ms))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn report_slowest(viewport: &str, label: &str, samples: &[Sample]) {
        let mut sorted: Vec<&Sample> = samples.iter().collect();
        sorted.sort_by(|a, b| {
            (b.js_cpu_ms + b.core_cpu_ms)
                .partial_cmp(&(a.js_cpu_ms + a.core_cpu_ms))
                .unwrap()
                .then_with(|| a.frame.cmp(&b.frame))
        });
        let run = std::env::var("G6_RUN_LABEL").unwrap_or_else(|_| "1".into());
        let ranked: Vec<&Sample> = sorted.into_iter().take(20).collect();
        let ranked_frames: HashSet<usize> = ranked.iter().map(|sample| sample.frame).collect();
        for (index, sample) in ranked.into_iter().enumerate() {
            let profile = format_frame_profile(sample);
            println!(
                "SLOW_FRAME suite={label} run={run} pid={} viewport={viewport} rank={} frame={} map={} class={} temperature={} qjs_cpu={:.3}ms core_cpu={:.3}ms draw_cpu={:.3}ms qjs_wall={:.3}ms core_wall={:.3}ms draw_wall={:.3}ms gc={:.3}ms in_tick_gc={} draw_sampled={} profile=[{}]",
                std::process::id(),
                index + 1,
                sample.frame,
                sample.map,
                sample.class,
                sample.temperature,
                sample.js_cpu_ms,
                sample.core_cpu_ms,
                sample.draw_cpu_ms,
                sample.js_ms,
                sample.core_ms,
                sample.draw_ms,
                sample.gc_ms,
                sample.in_tick_gc,
                sample.draw_sampled,
                if profile.is_empty() { "none" } else { &profile },
            );
        }
        for sample in samples
            .iter()
            .filter(|sample| !sample.profile.is_empty() && !ranked_frames.contains(&sample.frame))
        {
            println!(
                "PROFILE_FRAME suite={label} run={run} pid={} viewport={viewport} frame={} map={} class={} temperature={} qjs_cpu={:.3}ms core_cpu={:.3}ms qjs_wall={:.3}ms core_wall={:.3}ms profile=[{}]",
                std::process::id(),
                sample.frame,
                sample.map,
                sample.class,
                sample.temperature,
                sample.js_cpu_ms,
                sample.core_cpu_ms,
                sample.js_ms,
                sample.core_ms,
                format_frame_profile(sample),
            );
        }
    }

    /// One line per viewport for the production boundary-GC contract. CPU
    /// work remains the 50 ms gate; wall work + boundary pause is reported
    /// separately so the collector never disappears from the evidence.
    fn idle_gc_summary(viewport: &str, bench: &Bench, samples: &[Sample]) {
        assert!(
            !samples.is_empty(),
            "GC summary requires at least one frame"
        );
        let mut cpu_work: Vec<f64> = samples
            .iter()
            .map(|sample| sample.js_cpu_ms + sample.core_cpu_ms)
            .collect();
        let mut work: Vec<f64> = samples
            .iter()
            .map(|sample| sample.js_ms + sample.core_ms)
            .collect();
        let mut combined: Vec<f64> = samples
            .iter()
            .map(|sample| sample.js_ms + sample.core_ms + sample.gc_ms)
            .collect();
        cpu_work.sort_by(|a, b| a.partial_cmp(b).unwrap());
        work.sort_by(|a, b| a.partial_cmp(b).unwrap());
        combined.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
        let over = |values: &[f64], ms: f64| values.iter().filter(|value| **value > ms).count();
        let in_tick = samples.iter().filter(|sample| sample.in_tick_gc).count();
        let in_tick_cpu_max = samples
            .iter()
            .filter(|sample| sample.in_tick_gc)
            .map(|sample| sample.js_cpu_ms + sample.core_cpu_ms)
            .fold(0.0, f64::max);
        let stats = bench.rt.guest.idle_gc_stats().unwrap_or_default();
        let peak = samples
            .iter()
            .map(|sample| sample.heap_bytes)
            .max()
            .unwrap_or(0)
            .max(stats.peak_bytes);
        println!(
            "IDLEGC_CPU viewport={viewport} mode={} n={} cpu_work_mean={:.3}ms cpu_work_p99={:.3}ms cpu_work_max={:.3}ms cpu_over25={} cpu_over50={} in_tick_gc={in_tick} in_tick_gc_cpu_max={in_tick_cpu_max:.3}ms",
            bench.gc_mode.label(),
            samples.len(),
            mean(&cpu_work),
            percentile(&cpu_work, 0.99),
            cpu_work[cpu_work.len() - 1],
            over(&cpu_work, 25.0),
            over(&cpu_work, 50.0),
        );
        println!(
            "IDLEGC viewport={viewport} mode={} n={} work_mean={:.3}ms work_p99={:.3}ms work_max={:.3}ms combined_p99={:.3}ms combined_max={:.3}ms combined_over50={} idle_collections={} forced={} deferred={} pause_max={:.3}ms pause_total={:.3}ms peak_heap={:.2}MiB",
            bench.gc_mode.label(),
            samples.len(),
            mean(&work),
            percentile(&work, 0.99),
            work[work.len() - 1],
            percentile(&combined, 0.99),
            combined[combined.len() - 1],
            over(&combined, 50.0),
            stats.idle_collections,
            stats.forced_collections,
            stats.deferred_boundaries,
            stats.max_pause.as_secs_f64() * 1_000.0,
            stats.total_pause.as_secs_f64() * 1_000.0,
            peak as f64 / 1_048_576.0,
        );
    }

    fn report(viewport: &str, label: &str, samples: &[Sample]) {
        if samples.is_empty() {
            println!("SKIP viewport={viewport} kind={label} (no samples)");
            return;
        }
        let mut js: Vec<f64> = samples.iter().map(|sample| sample.js_ms).collect();
        let mut js_cpu: Vec<f64> = samples.iter().map(|sample| sample.js_cpu_ms).collect();
        let mut total: Vec<f64> = samples
            .iter()
            .filter(|sample| sample.draw_sampled)
            .map(|sample| sample.js_ms + sample.core_ms + sample.draw_ms)
            .collect();
        if total.is_empty() {
            println!("SKIP viewport={viewport} kind={label} (no framebuffer samples)");
            return;
        }
        js.sort_by(|a, b| a.partial_cmp(b).unwrap());
        js_cpu.sort_by(|a, b| a.partial_cmp(b).unwrap());
        total.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let worst = samples
            .iter()
            .filter(|sample| sample.draw_sampled)
            .max_by(|a, b| {
                (a.js_ms + a.core_ms + a.draw_ms)
                    .partial_cmp(&(b.js_ms + b.core_ms + b.draw_ms))
                    .unwrap()
            })
            .unwrap();
        let structural = samples
            .iter()
            .fold(StructuralOps::default(), |mut total, sample| {
                total.create += sample.structural.create;
                total.destroy += sample.structural.destroy;
                total.insert += sample.structural.insert;
                total.remove += sample.structural.remove;
                total
            });
        let structural_max = samples
            .iter()
            .map(|sample| sample.structural.total())
            .max()
            .unwrap_or(0);
        let js_mean = js.iter().sum::<f64>() / js.len() as f64;
        let js_cpu_mean = js_cpu.iter().sum::<f64>() / js_cpu.len() as f64;
        let total_mean = total.iter().sum::<f64>() / total.len() as f64;
        println!(
            "CASE viewport={viewport} kind={label} n={} total_n={} qjs_mean={js_mean:.3}ms qjs_p95={:.3}ms qjs_max={:.3}ms qjs_cpu_mean={js_cpu_mean:.3}ms qjs_cpu_p95={:.3}ms total_mean={total_mean:.3}ms total_p95={:.3}ms total_max={:.3}ms worst=f{}:{} structural={}/{}/{}/{} structural_max={}",
            samples.len(),
            total.len(),
            percentile(&js, 0.95),
            js[js.len() - 1],
            percentile(&js_cpu, 0.95),
            percentile(&total, 0.95),
            total[total.len() - 1],
            worst.frame,
            worst.map,
            structural.create,
            structural.destroy,
            structural.insert,
            structural.remove,
            structural_max,
        );
    }

    fn assert_zero_structural(viewport: &str, label: &str, samples: &[Sample]) {
        let churn: Vec<String> = samples
            .iter()
            .filter(|sample| sample.structural.total() != 0)
            .map(|sample| {
                format!(
                    "f{}:{}/{}/{}/{}",
                    sample.frame,
                    sample.structural.create,
                    sample.structural.destroy,
                    sample.structural.insert,
                    sample.structural.remove,
                )
            })
            .collect();
        assert!(
            churn.is_empty(),
            "{viewport} {label} performed structural UI operations: {}",
            churn.join(","),
        );
        println!(
            "STRUCTURE viewport={viewport} kind={label} frames={} structural=0",
            samples.len()
        );
    }

    /// G6_BATTLE_BUCKETS: break battle-steady frames down by player/enemy
    /// party size, battle event (performance stage), and menu mode, so the
    /// short-vs-long journey p95 delta can be attributed to sample shape
    /// (more monsters, longer animations) rather than a regression.
    fn report_buckets(viewport: &str, label: &str, samples: &[Sample]) {
        use std::collections::BTreeMap;
        let mut groups: BTreeMap<(u8, u8, String, String), Vec<f64>> = BTreeMap::new();
        for sample in samples {
            let key = (
                sample.player_party,
                sample.enemy_party,
                sample.battle_event.clone().unwrap_or_else(|| "-".into()),
                sample.menu_mode.clone().unwrap_or_else(|| "-".into()),
            );
            groups.entry(key).or_default().push(sample.js_ms);
        }
        let mut rows: Vec<_> = groups.into_iter().collect();
        rows.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
        println!(
            "BUCKETS viewport={viewport} kind={label} groups={} frames={}",
            rows.len(),
            samples.len()
        );
        for ((pp, ep, event, menu), mut js) in rows {
            js.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p95 = percentile(&js, 0.95);
            let max = js[js.len() - 1];
            let mean = js.iter().sum::<f64>() / js.len() as f64;
            println!(
                "BUCKET viewport={viewport} kind={label} pp={pp} ep={ep} event={event} menu={menu} n={} qjs_mean={mean:.3}ms qjs_p95={p95:.3}ms qjs_max={max:.3}ms",
                js.len(),
            );
        }
    }

    /// Reads `globalThis.__gp1Marks` right after boot and prints the full
    /// startup breakdown: host init, bundle compile, bundle eval split
    /// into "before module-start" (solid-js + framework top-level init,
    /// invisible to the marks alone — see `gp1_eval_staged`) and the four
    /// `ui/gp1-marks.ts` stages (engine/json-literals/language-data/
    /// battle-registration/mount), then the small post-eval host tail. `stages` (host_init_ms,
    /// compile_ms, eval_ms, host_finish_ms) all come from `Instant` at the
    /// real host call boundaries in `boot_staged` — nanosecond resolution.
    /// The four named JS stages still come from `Date.now()` marks (integer
    /// ms — QuickJS has no `performance.now()` and none of this may touch
    /// pocket-mod/vendor to add one), so only their *sum* is cross-checked
    /// against the host-measured `eval_ms - pre_module_start_ms`, not each
    /// individual delta. `assert_gp1_marks` fails the bench outright on a
    /// missing, renamed, or reordered mark — this can no longer silently
    /// print a partial table.
    fn report_startup_stages(viewport: &str, bench: &Bench, boot_ms: f64, stages: &StageTimes) {
        let marks: Vec<Gp1Mark> =
            serde_json::from_str(&bench.string("JSON.stringify(globalThis.__gp1Marks ?? [])"))
                .expect("gp1 marks JSON");
        assert_gp1_marks(&marks);
        println!(
            "STAGE viewport={viewport} name=host-init at_ms=0.000 delta_ms={:.3}",
            stages.host_init_ms,
        );
        println!(
            "STAGE viewport={viewport} name=compile at_ms={:.3} delta_ms={:.3}",
            stages.host_init_ms, stages.compile_ms,
        );
        let eval_start_ms = stages.host_init_ms + stages.compile_ms;
        let t0 = marks[0].at;
        let marked_span_ms = marks[marks.len() - 1].at - t0;
        let pre_module_start_ms = (stages.eval_ms - marked_span_ms).max(0.0);
        println!(
            "STAGE viewport={viewport} name=eval-before-module-start at_ms={:.3} delta_ms={:.3}",
            eval_start_ms, pre_module_start_ms,
        );
        let mut prev = t0;
        for mark in &marks {
            println!(
                "STAGE viewport={viewport} name={} at_ms={:.3} delta_ms={:.3}",
                mark.name,
                eval_start_ms + pre_module_start_ms + (mark.at - t0),
                mark.at - prev,
            );
            prev = mark.at;
        }
        let eval_end_ms = eval_start_ms + stages.eval_ms;
        println!(
            "STAGE viewport={viewport} name=host-finish at_ms={:.3} delta_ms={:.3}",
            eval_end_ms, stages.host_finish_ms,
        );
        let accounted_ms = eval_end_ms + stages.host_finish_ms;
        println!(
            "STAGE viewport={viewport} name=TOTAL accounted_ms={:.3} boot_ms={:.3} unaccounted_ms={:.3}",
            accounted_ms,
            boot_ms,
            boot_ms - accounted_ms,
        );
    }

    fn assert_frame_budget(label: &str, samples: &[Sample], limit_ms: f64) {
        // Comparison runs may lift the hard stop so the summary still records
        // a known-over-budget auto-GC spike. The normal command leaves this
        // unset and therefore enforces the production 50 ms gate.
        let limit_ms = std::env::var("G6_BUDGET_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(limit_ms);
        if samples.is_empty() {
            println!("SKIP budget kind={label} (no samples)");
            return;
        }
        // The budget asserts on THREAD CPU time (js_cpu + core_cpu), which is
        // immune to host descheduling: a frame the scheduler parks for 100 ms
        // shows only its real CPU cost.  Wall clock is reported alongside for
        // the record but is not the assertion basis.
        let qjs_core = samples
            .iter()
            .max_by(|a, b| {
                (a.js_cpu_ms + a.core_cpu_ms)
                    .partial_cmp(&(b.js_cpu_ms + b.core_cpu_ms))
                    .unwrap()
            })
            .unwrap();
        let qjs_core_cpu = qjs_core.js_cpu_ms + qjs_core.core_cpu_ms;
        let qjs_core_wall = qjs_core.js_ms + qjs_core.core_ms;
        assert!(
            qjs_core_cpu <= limit_ms,
            "{label} frame f{}:{} exceeded the {limit_ms} ms QJS/core CPU limit: {:.3} ms (wall {:.3} ms)",
            qjs_core.frame,
            qjs_core.map,
            qjs_core_cpu,
            qjs_core_wall,
        );
        let sample = samples
            .iter()
            .filter(|sample| sample.draw_sampled)
            .max_by(|a, b| {
                (a.js_cpu_ms + a.core_cpu_ms + a.draw_cpu_ms)
                    .partial_cmp(&(b.js_cpu_ms + b.core_cpu_ms + b.draw_cpu_ms))
                    .unwrap()
            })
            .unwrap_or_else(|| panic!("{label} has no framebuffer samples"));
        let total_cpu = sample.js_cpu_ms + sample.core_cpu_ms + sample.draw_cpu_ms;
        let total_wall = sample.js_ms + sample.core_ms + sample.draw_ms;
        assert!(
            total_cpu <= limit_ms,
            "{label} frame f{}:{} exceeded the {:.0} ms CPU limit: {:.3} ms (wall {:.3} ms = qjs {:.3} + core {:.3} + draw {:.3})",
            sample.frame,
            sample.map,
            limit_ms,
            total_cpu,
            total_wall,
            sample.js_cpu_ms,
            sample.core_cpu_ms,
            sample.draw_cpu_ms,
        );
        println!(
            "BUDGET kind={label} frames={} qjs_core_max_cpu={qjs_core_cpu:.3}ms wall={qjs_core_wall:.3}ms sampled_total_max_cpu={total_cpu:.3}ms wall={total_wall:.3}ms limit={limit_ms:.0}ms cpu_clock={}",
            samples.len(),
            if thread_cpu::AVAILABLE {
                "thread-cputime"
            } else {
                "wall-fallback"
            },
        );
    }

    struct CompletedHandoff {
        source: String,
        target: String,
        phases: Vec<Sample>,
        landing: Sample,
    }

    #[derive(Default)]
    struct HandoffTracker {
        active: Option<(String, String, Vec<Sample>)>,
        completed: Vec<CompletedHandoff>,
    }

    impl HandoffTracker {
        fn observe(&mut self, sample: &Sample) {
            match &sample.handoff {
                Some(handoff) => {
                    assert_eq!(
                        handoff.total_ticks, 8,
                        "handoff {} -> {} must expose the eight 60 Hz phases",
                        handoff.source_map_id, handoff.target_map_id,
                    );
                    assert_eq!(
                        sample.live_map, handoff.source_map_id,
                        "handoff phase {} changed the active map early",
                        handoff.phase,
                    );
                    assert!(
                        !sample.live_fade,
                        "handoff phase {} retained a fade",
                        handoff.phase
                    );
                    if self.active.is_none() {
                        assert_eq!(
                            handoff.phase, 0,
                            "first observed handoff frame must be phase 0"
                        );
                        self.active = Some((
                            handoff.source_map_id.clone(),
                            handoff.target_map_id.clone(),
                            Vec::with_capacity(handoff.total_ticks),
                        ));
                    }
                    let (source, target, phases) = self.active.as_mut().unwrap();
                    assert_eq!(
                        &handoff.source_map_id, source,
                        "handoff source changed mid-crossing"
                    );
                    assert_eq!(
                        &handoff.target_map_id, target,
                        "handoff target changed mid-crossing"
                    );
                    assert_eq!(
                        handoff.phase,
                        phases.len(),
                        "handoff {} -> {} skipped or duplicated a phase",
                        source,
                        target,
                    );
                    phases.push(sample.clone());
                }
                None => {
                    let Some((source, target, phases)) = self.active.take() else {
                        return;
                    };
                    let observed: Vec<usize> = phases
                        .iter()
                        .map(|phase| phase.handoff.as_ref().unwrap().phase)
                        .collect();
                    assert_eq!(
                        observed,
                        (0..8).collect::<Vec<_>>(),
                        "handoff {source} -> {target} has an incomplete phase sequence",
                    );
                    assert_eq!(
                        sample.live_map, target,
                        "handoff landing did not enter its target map"
                    );
                    assert!(!sample.live_fade, "handoff landing retained a fade");
                    self.completed.push(CompletedHandoff {
                        source,
                        target,
                        phases,
                        landing: sample.clone(),
                    });
                }
            }
        }

        fn finish(self) -> Vec<CompletedHandoff> {
            assert!(
                self.active.is_none(),
                "journey ended during a seamless handoff"
            );
            assert!(
                !self.completed.is_empty(),
                "G6_HANDOFF_BUCKETS requires at least one complete seamless handoff",
            );
            self.completed
        }
    }

    /// Handoff buckets have a fixed, strict release gate. In particular this
    /// does not inherit G6_BUDGET_MS, which exists for exploratory GC runs:
    /// every phase and landing must remain below 50 ms in GB6/J3 evidence.
    fn report_handoff_bucket(viewport: &str, label: &str, samples: &[Sample]) {
        report(viewport, label, samples);
        let work = samples
            .iter()
            .max_by(|a, b| {
                (a.js_cpu_ms + a.core_cpu_ms)
                    .partial_cmp(&(b.js_cpu_ms + b.core_cpu_ms))
                    .unwrap()
            })
            .expect("handoff bucket must not be empty");
        let work_cpu = work.js_cpu_ms + work.core_cpu_ms;
        let total = samples
            .iter()
            .filter(|sample| sample.draw_sampled)
            .max_by(|a, b| {
                (a.js_cpu_ms + a.core_cpu_ms + a.draw_cpu_ms)
                    .partial_cmp(&(b.js_cpu_ms + b.core_cpu_ms + b.draw_cpu_ms))
                    .unwrap()
            })
            .unwrap_or_else(|| panic!("{label} has no framebuffer sample"));
        let total_cpu = total.js_cpu_ms + total.core_cpu_ms + total.draw_cpu_ms;
        assert!(
            work_cpu < 50.0,
            "{label} frame f{}:{} reached the 50 ms QJS/core CPU gate: {:.3} ms",
            work.frame,
            work.live_map,
            work_cpu,
        );
        assert!(
            total_cpu < 50.0,
            "{label} frame f{}:{} reached the 50 ms sampled-total CPU gate: {:.3} ms",
            total.frame,
            total.live_map,
            total_cpu,
        );
        println!(
            "HANDOFF_BUCKET viewport={viewport} kind={label} n={} qjs_core_cpu_max={work_cpu:.3}ms qjs_core_wall={:.3}ms total_cpu_max={total_cpu:.3}ms total_wall={:.3}ms limit=<50ms",
            samples.len(),
            work.js_ms + work.core_ms,
            total.js_ms + total.core_ms + total.draw_ms,
        );
    }

    fn report_handoffs(viewport: &str, completed: &[CompletedHandoff]) {
        assert!(!completed.is_empty(), "handoff report must not be empty");
        let mut phases: Vec<Vec<Sample>> = (0..8).map(|_| Vec::new()).collect();
        let mut landings = Vec::with_capacity(completed.len());
        for (index, handoff) in completed.iter().enumerate() {
            assert_eq!(
                handoff.phases.len(),
                8,
                "handoff sequence must contain every phase"
            );
            for (phase, sample) in handoff.phases.iter().enumerate() {
                assert_eq!(sample.handoff.as_ref().unwrap().phase, phase);
                phases[phase].push(sample.clone());
            }
            landings.push(handoff.landing.clone());
            println!(
                "HANDOFF_SEQUENCE viewport={viewport} index={index} source={} target={} phases=0,1,2,3,4,5,6,7 landing=f{}",
                handoff.source, handoff.target, handoff.landing.frame,
            );
        }
        println!(
            "HANDOFFS viewport={viewport} crossings={} phase_frames={} landing_frames={}",
            completed.len(),
            phases.iter().map(Vec::len).sum::<usize>(),
            landings.len(),
        );
        for (phase, samples) in phases.iter().enumerate() {
            assert_eq!(
                samples.len(),
                completed.len(),
                "handoff phase {phase} must occur once per crossing",
            );
            report_handoff_bucket(viewport, &format!("handoff-phase-{phase}"), samples);
        }
        assert_eq!(
            landings.len(),
            completed.len(),
            "every crossing must have one landing frame"
        );
        report_handoff_bucket(viewport, "handoff-landing", &landings);
    }

    fn args(dist: &PathBuf, app: &str, data: PathBuf, width: u32, height: u32) -> Args {
        Args {
            app: app.into(),
            js: Some(dist.join(format!("{app}.js"))),
            pak: Some(dist.join(format!("{app}.pak"))),
            file: None,
            data_root: Some(data),
            app_id: Some(BENCH_APP_ID.into()),
            title: "G6 QuickJS bench".into(),
            viewport: (width, height),
            fixed: false,
            native_text: false,
            editor: false,
            companions: Vec::new(),
            system: None,
            svc_connect: None,
            density: 1,
            script: Vec::new(),
            quit_after_ticks: None,
            storm: None,
            announce_ready: false,
            trace_frames: false,
        }
    }

    fn seed_maps(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("maps");
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination).expect("create benchmark map data directory");
        let mut copied = 0usize;
        for entry in std::fs::read_dir(source).expect("read G6_MAPS") {
            let entry = entry.expect("read map directory entry");
            let path = entry.path();
            if !entry.file_type().expect("read map entry type").is_file()
                || !matches!(
                    path.extension().and_then(|value| value.to_str()),
                    Some("json" | "rkm")
                )
            {
                continue;
            }
            std::fs::copy(&path, destination.join(entry.file_name())).expect("copy map entry");
            copied += 1;
        }
        assert_eq!(copied, 263, "benchmark must stage every imported map");
    }

    /// Stage the zh_CN map shards so a Chinese-language tape can leave the
    /// bedroom and enter maps whose shell references `maps-zh/`.
    fn seed_maps_zh(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("maps-zh");
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination).expect("create benchmark zh map data directory");
        for entry in std::fs::read_dir(source).expect("read G6_MAPS_ZH") {
            let entry = entry.expect("read zh map directory entry");
            let path = entry.path();
            if !entry.file_type().expect("read zh map entry type").is_file()
                || !matches!(
                    path.extension().and_then(|value| value.to_str()),
                    Some("json" | "rkm")
                )
            {
                continue;
            }
            std::fs::copy(&path, destination.join(entry.file_name())).expect("copy zh map entry");
        }
    }

    /// Recursively stages the sharded battle-runtime tree (`battle/monsters`,
    /// `battle/techniques`, `battle/items`, `battle/statuses`) the same way
    /// the desktop launcher does: readFileSync on desktop resolves against
    /// data.fs, not the pak, so a battle started under this bench needs these
    /// files physically present under the benchmark's own data root.
    fn copy_dir_recursive(source: &Path, destination: &Path) -> usize {
        std::fs::create_dir_all(destination).expect("create benchmark battle data directory");
        let mut copied = 0usize;
        for entry in std::fs::read_dir(source).expect("read G6_BATTLE") {
            let entry = entry.expect("read battle directory entry");
            let path = entry.path();
            let target = destination.join(entry.file_name());
            if path.is_dir() {
                copied += copy_dir_recursive(&path, &target);
            } else if path.extension().and_then(|value| value.to_str()) == Some("json") {
                std::fs::copy(&path, &target).expect("copy battle entry");
                copied += 1;
            }
        }
        copied
    }

    fn seed_battle(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("battle");
        let _ = std::fs::remove_dir_all(&destination);
        let copied = copy_dir_recursive(source, &destination);
        assert!(
            copied > 0,
            "benchmark must stage the sharded battle database"
        );
    }

    /// Stage on-demand IMG directories that the desktop launcher keeps in
    /// data.fs. The filesystem host intentionally wins over pak lookup, so a
    /// benchmark fixture must mirror these sidecar entries as well.
    fn seed_img_entries(source: &Path, directory: &str, data_root: &Path) {
        let destination = data_root.join(BENCH_APP_ID).join("data").join(directory);
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination)
            .unwrap_or_else(|error| panic!("create benchmark {directory} directory: {error}"));
        let mut copied = 0usize;
        for entry in std::fs::read_dir(source)
            .unwrap_or_else(|error| panic!("read benchmark {directory} directory: {error}"))
        {
            let entry = entry.expect("read benchmark IMG entry");
            let path = entry.path();
            if !entry
                .file_type()
                .expect("read benchmark IMG entry type")
                .is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("img")
            {
                continue;
            }
            std::fs::copy(&path, destination.join(entry.file_name()))
                .unwrap_or_else(|error| panic!("copy benchmark {directory} entry: {error}"));
            copied += 1;
        }
        assert!(copied > 0, "benchmark must stage {directory} IMG entries");
    }

    /// Mirrors tools/desktop.ts's five raw zh_CN startup entries. They are
    /// staged before boot (outside the timed interval), exactly like a real
    /// desktop launcher's persistent data.fs tree.
    fn seed_zh_startup(data_root: &Path) {
        let destination = data_root
            .join(BENCH_APP_ID)
            .join("data")
            .join("l10n")
            .join("zh_CN");
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination).expect("create benchmark zh startup directory");
        for (env_name, file_name) in [
            ("G6_ZH_PROJECT", "project-shell.json"),
            ("G6_ZH_BATTLE_SHELL", "battle-runtime-shell.json"),
            ("G6_ZH_NAMES", "battle-names.json"),
            ("G6_ZH_MAP_DESCRIPTIONS", "map-descriptions.json"),
            ("G6_ZH_MONTH_NAMES", "month-names.json"),
        ] {
            let source = PathBuf::from(std::env::var(env_name).unwrap_or_else(|_| {
                panic!("{env_name} must name a zh_CN startup document")
            }));
            std::fs::copy(&source, destination.join(file_name)).unwrap_or_else(|error| {
                panic!("copy {} to zh_CN startup data: {error}", source.display())
            });
        }
    }

    /// Stage every audio manifest entry under its exact resource key. The
    /// production desktop build removes these lazy payloads from the startup
    /// pak and resolves them through data.fs; benchmark boots mirror that
    /// layout so audio playback exercises the shipped path.
    fn seed_audio(data_root: &Path) {
        let source_root = PathBuf::from(
            std::env::var("G6_AUDIO_ROOT").expect("G6_AUDIO_ROOT"),
        );
        let manifest_path = PathBuf::from(
            std::env::var("G6_AUDIO_MANIFEST").expect("G6_AUDIO_MANIFEST"),
        );
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&manifest_path).expect("read audio manifest"),
        )
        .expect("parse audio manifest");
        let files = manifest
            .get("files")
            .and_then(serde_json::Value::as_object)
            .expect("audio manifest files object");
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        std::fs::create_dir_all(&app_data).expect("create benchmark app data directory");
        for entry in std::fs::read_dir(&app_data).expect("read benchmark app data directory") {
            let entry = entry.expect("read benchmark app data entry");
            if entry.file_name().to_string_lossy().starts_with("audio:") {
                let _ = std::fs::remove_dir_all(entry.path());
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let mut copied = 0usize;
        for (relative, metadata) in files {
            let key = metadata
                .get("pakKey")
                .and_then(serde_json::Value::as_str)
                .expect("audio manifest pakKey");
            assert!(
                key.starts_with("audio:")
                    && !key.split('/').any(|part| part.is_empty() || part == ".."),
                "unsafe benchmark audio key: {key}",
            );
            assert!(
                !relative.split('/').any(|part| part.is_empty() || part == ".."),
                "unsafe benchmark audio path: {relative}",
            );
            let destination = app_data.join(key);
            std::fs::create_dir_all(destination.parent().unwrap())
                .expect("create benchmark audio directory");
            std::fs::copy(source_root.join(relative), &destination).unwrap_or_else(|error| {
                panic!("copy audio entry {relative} to {key}: {error}")
            });
            copied += 1;
        }
        assert!(copied > 0, "benchmark must stage at least one audio entry");
    }

    /// Stages the sharded animated-tile tree (`dist/animated/<mapId>.json`)
    /// the same way maps and battle shards are
    /// staged: readFileSync on desktop resolves against data.fs, so any map
    /// with animated tiles needs its shard physically present here.
    fn seed_animated(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("animated");
        let _ = std::fs::remove_dir_all(&destination);
        let copied = copy_dir_recursive(source, &destination);
        assert!(
            copied > 0,
            "benchmark must stage the sharded animated-tile table"
        );
    }

    /// Stages the sharded per-NPC sprite table (`dist/npc-src/<npcId>.json`),
    /// same reasoning as `seed_animated`.
    fn seed_npc_src(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("npc-src");
        let _ = std::fs::remove_dir_all(&destination);
        let copied = copy_dir_recursive(source, &destination);
        assert!(
            copied > 0,
            "benchmark must stage the sharded NPC sprite table"
        );
    }

    /// Stages the sharded terrain-stream ground/upper chunk-ref tables
    /// (`dist/terrain-stream/{ground,upper}/<mapId>.json`), same reasoning
    /// as `seed_battle`.
    fn seed_terrain_stream(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("terrain-stream");
        let _ = std::fs::remove_dir_all(&destination);
        let copied = copy_dir_recursive(source, &destination);
        assert!(
            copied > 0,
            "benchmark must stage the sharded terrain-stream tables"
        );
    }

    /// Stages the packed chapter snapshots and input tape used by an optional
    /// continuation start. Production desktop launchers copy these entries
    /// into data.fs alongside the streamed repositories; the benchmark host
    /// must mirror that layout before asking the public demo hook to jump.
    fn seed_demo(source: &Path, data_root: &Path) {
        let app_data = data_root.join(BENCH_APP_ID).join("data");
        let destination = app_data.join("demo");
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination).expect("create benchmark demo data directory");
        for name in ["chapters.json", "tape.bin"] {
            std::fs::copy(source.join(name), destination.join(name))
                .unwrap_or_else(|error| panic!("copy demo entry {name}: {error}"));
        }
    }

    #[test]
    #[ignore]
    fn journey() {
        let dist = PathBuf::from(std::env::var("G6_DIST").expect("G6_DIST"));
        let journey_path = PathBuf::from(std::env::var("G6_JOURNEY").expect("G6_JOURNEY"));
        let journey: Journey =
            serde_json::from_slice(&std::fs::read(journey_path).unwrap()).unwrap();
        let width: u32 = std::env::var("G6_BENCH_W").unwrap().parse().unwrap();
        let height: u32 = std::env::var("G6_BENCH_H").unwrap().parse().unwrap();
        let viewport = format!("{width}x{height}");
        let bench_root = PathBuf::from(std::env::var("G6_BENCH_ROOT").expect("G6_BENCH_ROOT"));
        let data = bench_root.join(format!("qjs-data-{}-{width}x{height}", std::process::id()));
        let maps = PathBuf::from(std::env::var("G6_MAPS").expect("G6_MAPS"));
        seed_maps(&maps, &data);
        if let Ok(maps_zh) = std::env::var("G6_MAPS_ZH") {
            seed_maps_zh(Path::new(&maps_zh), &data);
        }
        let battle = PathBuf::from(std::env::var("G6_BATTLE").expect("G6_BATTLE"));
        seed_battle(&battle, &data);
        let portraits = PathBuf::from(std::env::var("G6_PORTRAITS").expect("G6_PORTRAITS"));
        seed_img_entries(&portraits, "portraits", &data);
        let choice_icons =
            PathBuf::from(std::env::var("G6_CHOICE_ICONS").expect("G6_CHOICE_ICONS"));
        seed_img_entries(&choice_icons, "choice-icons", &data);
        if let Ok(battle_zh) = std::env::var("G6_BATTLE_ZH") {
            copy_dir_recursive(
                Path::new(&battle_zh),
                &data.join(BENCH_APP_ID).join("data").join("battle-zh"),
            );
        }
        let zh_requested = std::env::var("G6_LANG")
            .is_ok_and(|lang| lang == "zh" || lang == "zh_CN");
        if zh_requested {
            seed_zh_startup(&data);
        } else {
            // This is an integration guard over the actual production entry:
            // an English boot gets no zh_CN files at all, so an accidental
            // eager zhData.load() fails here instead of being hidden by the
            // benchmark fixture seeding every locale unconditionally.
            assert!(
                !data.join(BENCH_APP_ID).join("data/l10n/zh_CN").exists(),
                "English benchmark must not stage zh_CN startup documents",
            );
        }
        let animated = PathBuf::from(std::env::var("G6_ANIMATED").expect("G6_ANIMATED"));
        seed_animated(&animated, &data);
        let npc_src = PathBuf::from(std::env::var("G6_NPC_SRC").expect("G6_NPC_SRC"));
        seed_npc_src(&npc_src, &data);
        let terrain_stream =
            PathBuf::from(std::env::var("G6_TERRAIN_STREAM").expect("G6_TERRAIN_STREAM"));
        seed_terrain_stream(&terrain_stream, &data);
        seed_audio(&data);
        if std::env::var("G6_START_CHAPTER").is_ok() {
            let demo = PathBuf::from(std::env::var("G6_DEMO").expect("G6_DEMO"));
            seed_demo(&demo, &data);
        }

        let boot_start = Instant::now();
        let (runtime, stages) =
            boot_staged(args(&dist, "pocket-tuxemon", data.clone(), width, height)).unwrap();
        let boot_ms = boot_start.elapsed().as_secs_f64() * 1_000.0;
        let sample_structural = std::env::var("G6_FAST_BENCH").as_deref() != Ok("1");
        let battle_buckets = std::env::var("G6_BATTLE_BUCKETS").as_deref() == Ok("1");
        let handoff_buckets = std::env::var("G6_HANDOFF_BUCKETS").as_deref() == Ok("1");
        let hash_every = std::env::var("G6_HASH_EVERY")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1usize)
            .max(1);
        let (profile_frames, profile_marks, profile_capture) = frame_profile_config();
        let mut bench = Bench {
            rt: runtime,
            gc_mode: GcMode::from_env(),
            sample_structural,
            hash_every,
            battle_buckets,
            handoff_buckets,
            profile_frames,
            profile_marks,
            profile_capture,
        };
        bench.install_frame_profiler();
        report_startup_stages(&viewport, &bench, boot_ms, &stages);
        if sample_structural {
            bench.install_structural_counter();
        }
        // Continuation benches can restore a committed demo chapter before
        // frame zero. The first idle frame remains the real startup-to-first-
        // paint probe; a second unmeasured host frame applies the queued jump.
        // Every sample below then belongs to the continuation tape. Without
        // G6_START_CHAPTER this is exactly the original fresh-game path.
        let chapter_startup = std::env::var("G6_START_CHAPTER").ok().map(|chapter| {
            let first_paint = bench.frame(0, 0, None, true);
            let first_paint_ms = boot_start.elapsed().as_secs_f64() * 1_000.0;
            assert!(
                bench.boolean("typeof globalThis.__rpgkitDemo?.jump === 'function'"),
                "G6_START_CHAPTER requires the production demo hook",
            );
            bench.unit(&format!(
                "globalThis.__rpgkitDemo.jump({})",
                serde_json::to_string(&chapter).unwrap(),
            ));
            let _ = bench.frame(0, 0, None, true);
            let expected = journey
                .maps
                .first()
                .expect("continuation map checkpoint")
                .map
                .as_str();
            let actual = bench.state().0;
            if actual != expected {
                let text = bench.rt.surface.with_ui(|ui| {
                    fn visit(ui: &pocketjs_core::Ui, id: i32, out: &mut Vec<String>) {
                        if let Some(value) = ui.node_text(id).filter(|value| !value.is_empty()) {
                            out.push(value.to_owned());
                        }
                        for child in ui.node_children(id).to_vec() {
                            visit(ui, child, out);
                        }
                    }
                    let mut out = Vec::new();
                    visit(ui, pocketjs_core::spec::ROOT_ID, &mut out);
                    out.join(" | ")
                });
                panic!(
                    "chapter {chapter:?} restored {actual:?}, expected {expected:?}; UI: {text}"
                );
            }
            (first_paint, first_paint_ms)
        });
        if sample_structural {
            assert!(
                journey.maps.is_empty() || journey.battles.is_empty(),
                "short probe mode must classify live state rather than frozen metadata"
            );
        } else {
            assert!(
                !journey.maps.is_empty(),
                "fast benchmark requires journey map checkpoints"
            );
            assert!(
                !journey.battles.is_empty(),
                "fast benchmark requires journey battle checkpoints"
            );
        }
        let initial_map = if !sample_structural {
            journey.maps[0].map.clone()
        } else {
            bench.state().0
        };
        let frozen_at = |frame: usize| -> Option<(&str, bool)> {
            if !sample_structural {
                let map = journey
                    .maps
                    .iter()
                    .rev()
                    .find(|mark| mark.frame <= frame)
                    .unwrap();
                // Checkpoints describe the post-step scene. `startFrame` is
                // the input that enters battle; `endFrame` is one past the
                // input that exits it, so that exit input is already a world
                // scene sample.
                let battle = journey
                    .battles
                    .iter()
                    .any(|mark| mark.start_frame <= frame && frame + 1 < mark.end_frame);
                Some((map.map.as_str(), battle))
            } else {
                None
            }
        };
        let mut forced_hashes = HashSet::new();
        if !sample_structural {
            for mark in &journey.maps {
                // The seamless phase-0 frame is eight 60 Hz ticks before the
                // target-map checkpoint. Hash the whole lead-in so every
                // handoff bucket, as well as its landing, has a real draw
                // sample even when the long-tape default hashes 1/10 frames.
                for frame in mark.frame.saturating_sub(9)..=mark.frame.saturating_add(16) {
                    forced_hashes.insert(frame);
                }
            }
            for mark in &journey.battles {
                forced_hashes.insert(mark.start_frame);
                forced_hashes.insert(mark.start_frame.saturating_add(1));
                forced_hashes.insert(mark.end_frame.saturating_sub(1));
                forced_hashes.insert(mark.end_frame);
            }
        }
        let replay_started = Instant::now();
        let mut first = bench.frame(
            0,
            journey.masks[0],
            frozen_at(0),
            forced_hashes.contains(&0),
        );
        first.class = "first-frame".into();
        first.temperature = "cold";
        let (first_paint, first_paint_ms) = chapter_startup.unwrap_or_else(|| {
            let first_paint_ms = boot_start.elapsed().as_secs_f64() * 1_000.0;
            (first.clone(), first_paint_ms)
        });
        let (used, malloc, objects) = qjs_memory(&bench.rt.guest);
        println!(
            "BOOT viewport={viewport} gc_mode={} boot={boot_ms:.3}ms first_qjs={:.3}ms first_total={:.3}ms startup_to_first={first_paint_ms:.3}ms qjs_used={:.2}MiB qjs_malloc={:.2}MiB objects={objects}",
            bench.gc_mode.label(),
            first_paint.js_ms,
            first_paint.js_ms + first_paint.core_ms + first_paint.draw_ms,
            used as f64 / 1_048_576.0,
            malloc as f64 / 1_048_576.0,
        );
        let startup_limit_ms = std::env::var("G6_STARTUP_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(250.0);
        assert!(
            first_paint_ms <= startup_limit_ms,
            "startup viewport={viewport} exceeded the {startup_limit_ms:.3} ms startup-to-first-paint budget: {first_paint_ms:.3} ms",
        );

        let mut walking = Vec::new();
        let mut all_frames = Vec::with_capacity(journey.masks.len());
        all_frames.push(first.clone());
        let mut handoff_tracker = HandoffTracker::default();
        if handoff_buckets {
            handoff_tracker.observe(&first);
        }
        let mut walking_before_battle = Vec::new();
        let mut walking_after_battle = Vec::new();
        let mut switches = Vec::new();
        let mut battle = Vec::new();
        let mut battle_steady = Vec::new();
        let mut battle_round = Vec::new();
        let mut battle_decision = Vec::new();
        let mut battle_entry = Vec::new();
        let mut battle_exit = Vec::new();
        let mut last_map = initial_map;
        let mut last_battle = first.battle;
        let mut last_modal = first.modal.clone();
        let mut last_handoff = first.handoff.is_some();
        let mut seen_maps = HashSet::from([first.map.clone()]);
        let mut seen_modals: HashSet<String> = first.modal.iter().cloned().collect();
        let mut battle_entries = usize::from(first.battle);
        let mut battle_exits = 0usize;
        let mut battle_completed = false;
        let mut switch_tail = 0usize;
        let mut switch_temperature = "hot";
        let mut handoff_temperature = "hot";
        let mut transfers = 0usize;
        for (index, mask) in journey.masks.iter().copied().enumerate().skip(1) {
            let mut sample = bench.frame(
                index,
                mask,
                frozen_at(index),
                forced_hashes.contains(&index),
            );
            let battle_changed = sample.battle != last_battle;
            let map_changed = sample.map != last_map;
            let modal_opened = sample.modal.is_some() && sample.modal != last_modal;
            let first_map_visit = map_changed && !seen_maps.contains(&sample.map);
            if let Some(handoff) = &sample.handoff {
                if !last_handoff {
                    handoff_temperature = if seen_maps.contains(&handoff.target_map_id) {
                        "hot"
                    } else {
                        "cold"
                    };
                }
            }
            if map_changed {
                switch_temperature = if first_map_visit { "cold" } else { "hot" };
            }
            if battle_changed && sample.battle {
                sample.class = "battle-entry".into();
                sample.temperature = if battle_entries == 0 { "cold" } else { "hot" };
                battle_entries += 1;
            } else if battle_changed {
                sample.class = "battle-exit".into();
                sample.temperature = if battle_exits == 0 { "cold" } else { "hot" };
                battle_exits += 1;
            } else if let Some(handoff) = &sample.handoff {
                sample.class = format!("handoff-phase-{}", handoff.phase);
                sample.temperature = handoff_temperature;
            } else if last_handoff {
                sample.class = "handoff-landing".into();
                sample.temperature = handoff_temperature;
            } else if map_changed {
                sample.class = if first_map_visit {
                    "map-first-visit"
                } else {
                    "map-revisit"
                }
                .into();
                sample.temperature = switch_temperature;
            } else if modal_opened {
                let kind = sample.modal.as_deref().unwrap();
                let first_open = seen_modals.insert(kind.to_owned());
                sample.class = format!("dialog-open-{kind}");
                sample.temperature = if first_open { "cold" } else { "hot" };
            } else if sample.fade || switch_tail > 0 {
                sample.class = "map-switch-tail".into();
                sample.temperature = switch_temperature;
            } else if sample.battle {
                sample.class = match sample.battle_event.as_deref() {
                    Some(event) => format!("battle-{event}"),
                    None => "battle-steady".into(),
                };
            } else if sample.moving || mask & 0x00f0 != 0 {
                sample.class = "walking".into();
            } else {
                sample.class = "idle".into();
            }
            if handoff_buckets {
                handoff_tracker.observe(&sample);
            }
            if sample.battle {
                battle.push(sample.clone());
                if last_battle {
                    battle_steady.push(sample.clone());
                }
                if sample.battle_event.as_deref() == Some("round") {
                    battle_round.push(sample.clone());
                }
                if sample.battle_event.as_deref() == Some("decision") {
                    battle_decision.push(sample.clone());
                }
            }
            if battle_changed {
                if sample.battle {
                    battle_entry.push(sample.clone());
                } else {
                    battle_exit.push(sample.clone());
                    battle_completed = true;
                }
                last_battle = sample.battle;
            }
            if map_changed {
                seen_maps.insert(sample.map.clone());
                last_map = sample.map.clone();
                transfers += 1;
                switch_tail = 16;
            }
            if sample.fade || switch_tail > 0 {
                switches.push(sample.clone());
                switch_tail = switch_tail.saturating_sub(1);
            } else if sample.moving || mask & 0x00f0 != 0 {
                if battle_completed {
                    walking_after_battle.push(sample.clone());
                } else {
                    walking_before_battle.push(sample.clone());
                }
                walking.push(sample.clone());
            }
            all_frames.push(sample.clone());
            last_modal = sample.modal.clone();
            last_handoff = sample.handoff.is_some();
        }
        let replay_wall_ms = replay_started.elapsed().as_secs_f64() * 1_000.0;
        let (end_map, _, _, _, _, _) = bench.state();
        let expected_map =
            std::env::var("G6_EXPECTED_MAP").unwrap_or_else(|_| "spyder_route1".into());
        assert_eq!(end_map, expected_map);
        let state_text = bench.string("JSON.stringify(globalThis.__rpgSessionState)");
        let state: serde_json::Value =
            serde_json::from_str(&state_text).expect("terminal state JSON");
        let state_out = PathBuf::from(std::env::var("G6_STATE_OUT").expect("G6_STATE_OUT"));
        std::fs::write(&state_out, serde_json::to_vec(&state).unwrap())
            .expect("write canonical state");
        report(&viewport, "walking", &walking);
        report(&viewport, "walking-before-battle", &walking_before_battle);
        report(&viewport, "walking-after-battle", &walking_after_battle);
        report(&viewport, "map-switch", &switches);
        report(&viewport, "battle", &battle);
        report(&viewport, "battle-steady", &battle_steady);
        if sample_structural {
            assert_zero_structural(&viewport, "battle-steady", &battle_steady);
        } else {
            println!(
                "STRUCTURE viewport={viewport} kind=battle-steady frames={} structural=not-sampled",
                battle_steady.len(),
            );
        }
        if sample_structural {
            report(&viewport, "battle-round", &battle_round);
            report(&viewport, "battle-decision", &battle_decision);
        } else {
            println!(
                "CASE viewport={viewport} kind=battle-round source=standalone-reducer-benchmark"
            );
        }
        report(&viewport, "battle-entry", &battle_entry);
        report(&viewport, "battle-exit", &battle_exit);
        if battle_buckets {
            report_buckets(&viewport, "battle-steady", &battle_steady);
        }
        report(&viewport, "all", &all_frames);
        report_temperature(&viewport, "journey", &all_frames);
        report_slowest(&viewport, "journey", &all_frames);
        idle_gc_summary(&viewport, &bench, &all_frames);
        // Emit all diagnostics before enforcing the gates, so an over-budget
        // run still records its classified slow frame and opt-in profile
        // markers instead of stopping at the first aggregate table.
        assert_frame_budget("map-switch", &switches, 50.0);
        assert_frame_budget("battle-entry", &battle_entry, 50.0);
        assert_frame_budget("battle-exit", &battle_exit, 50.0);
        assert_frame_budget("all", &all_frames, 50.0);
        if handoff_buckets {
            let completed = handoff_tracker.finish();
            report_handoffs(&viewport, &completed);
        }
        let measured_qjs_core_ms = all_frames
            .iter()
            .map(|sample| sample.js_ms + sample.core_ms)
            .sum::<f64>();
        let sampled_draw_ms = all_frames
            .iter()
            .filter(|sample| sample.draw_sampled)
            .map(|sample| sample.draw_ms)
            .sum::<f64>();
        let sampled_draw_frames = all_frames
            .iter()
            .filter(|sample| sample.draw_sampled)
            .count();
        println!(
            "REPLAY viewport={viewport} frames={} qjs_core_ms={measured_qjs_core_ms:.3} sampled_draw_ms={sampled_draw_ms:.3} sampled_draw_frames={sampled_draw_frames} hash_every={hash_every} wall_ms={replay_wall_ms:.3}",
            journey.masks.len(),
        );
        let (used, malloc, objects) = qjs_memory(&bench.rt.guest);
        println!(
            "END viewport={viewport} frames={} transfers={} map={end_map} qjs_used={:.2}MiB qjs_malloc={:.2}MiB objects={objects}",
            journey.masks.len(),
            transfers,
            used as f64 / 1_048_576.0,
            malloc as f64 / 1_048_576.0,
        );
        let _ = std::fs::remove_dir_all(data);
    }

    /// Allocation probe: replay a tape segment of N frames (default 1,000)
    /// and report QuickJS cumulative allocation count, live malloc bytes,
    /// and GC-threshold transitions. Used to prove the weather overlay's
    /// per-frame path is zero-allocation: the regression
    /// (weather-alloc-regression.sh) runs the same bundle with the overlay's
    /// frame handler active vs skipped (G6_WEATHER_OVERLAY_NO_FRAME, overlay
    /// mounted identically in both) on the same tape window and diffs.
    /// G6_MEM_START skips to a later tape position (warm-up replay) so the
    /// probe can measure an outdoor segment where the overlay is active. The
    /// measured window is [start, start+frames): warm-up replays
    /// [0, start), and the first measured frame is `start` itself. With
    /// G6_MEM_PER_FRAME set, the probe also prints one MEM_FRAME line per
    /// measured frame with that frame's allocation count and bytes, so a
    /// main-vs-branch run can diff the two bundles frame by frame (see
    /// weather-alloc-main-diff.sh).
    #[test]
    #[ignore]
    fn mem_walk() {
        let dist = PathBuf::from(std::env::var("G6_DIST").expect("G6_DIST"));
        let journey_path = PathBuf::from(std::env::var("G6_JOURNEY").expect("G6_JOURNEY"));
        let journey: Journey =
            serde_json::from_slice(&std::fs::read(journey_path).unwrap()).unwrap();
        let width: u32 = std::env::var("G6_BENCH_W").unwrap().parse().unwrap();
        let height: u32 = std::env::var("G6_BENCH_H").unwrap().parse().unwrap();
        let viewport = format!("{width}x{height}");
        let start: usize = std::env::var("G6_MEM_START")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
            .min(journey.masks.len().saturating_sub(2));
        let frames: usize = std::env::var("G6_MEM_FRAMES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1_000)
            .min(journey.masks.len().saturating_sub(1).saturating_sub(start));
        let weather = std::env::var("G6_WEATHER").unwrap_or_else(|_| "sunny".into());
        let bench_root = PathBuf::from(std::env::var("G6_BENCH_ROOT").expect("G6_BENCH_ROOT"));
        let data = bench_root.join(format!("qjs-mem-{}-{width}x{height}", std::process::id()));
        let maps = PathBuf::from(std::env::var("G6_MAPS").expect("G6_MAPS"));
        seed_maps(&maps, &data);
        let battle = PathBuf::from(std::env::var("G6_BATTLE").expect("G6_BATTLE"));
        seed_battle(&battle, &data);
        let animated = PathBuf::from(std::env::var("G6_ANIMATED").expect("G6_ANIMATED"));
        seed_animated(&animated, &data);
        let npc_src = PathBuf::from(std::env::var("G6_NPC_SRC").expect("G6_NPC_SRC"));
        seed_npc_src(&npc_src, &data);
        let terrain_stream =
            PathBuf::from(std::env::var("G6_TERRAIN_STREAM").expect("G6_TERRAIN_STREAM"));
        seed_terrain_stream(&terrain_stream, &data);
        seed_audio(&data);

        let (runtime, _stages) =
            boot_staged(args(&dist, "pocket-tuxemon", data.clone(), width, height)).unwrap();
        // CountingAllocator cannot be composed with the production idle-GC
        // allocator; boot_staged therefore forces this probe to auto mode.
        let (profile_frames, profile_marks, profile_capture) = frame_profile_config();
        let mut bench = Bench {
            rt: runtime,
            gc_mode: GcMode::Auto,
            sample_structural: false,
            hash_every: 1,
            battle_buckets: false,
            handoff_buckets: false,
            profile_frames,
            profile_marks,
            profile_capture,
        };
        bench.install_frame_profiler();
        // Warm-up: replay up to `start` so the probe measures a specific
        // outdoor segment (the G6 tape opens indoors in a bedroom).
        for index in 0..start {
            let _sample = bench.frame(index, journey.masks[index], None, false);
        }
        let (count_start, size_start) = qjs_malloc_stats(&bench.rt.guest);
        let (alloc_start, bytes_start) = alloc_counts();
        let mut threshold = qjs_gc_threshold(&bench.rt.guest);
        let mut gc_threshold_transitions = 0u64;
        let mut size_min = size_start;
        let mut size_max = size_start;
        let per_frame = std::env::var("G6_MEM_PER_FRAME").is_ok();
        for offset in 0..frames {
            let index = start + offset;
            let mask = journey.masks[index];
            let (alloc_before, bytes_before) = alloc_counts();
            let _sample = bench.frame(index, mask, None, false);
            if per_frame {
                let (alloc_after, bytes_after) = alloc_counts();
                println!(
                    "MEM_FRAME frame={index} allocs={} bytes={}",
                    alloc_after - alloc_before,
                    bytes_after - bytes_before,
                );
            }
            // Sample every frame: a cycle GC between two sampled frames
            // would otherwise be invisible. This counts observed
            // JS_GetGCThreshold transitions, not exact GC invocations —
            // QuickJS exposes no GC hook, so the report must not claim a
            // precise GC count.
            let next_threshold = qjs_gc_threshold(&bench.rt.guest);
            if next_threshold != threshold {
                gc_threshold_transitions += 1;
                threshold = next_threshold;
            }
            let (_, size) = qjs_malloc_stats(&bench.rt.guest);
            size_min = size_min.min(size);
            size_max = size_max.max(size);
        }
        let (count_end, size_end) = qjs_malloc_stats(&bench.rt.guest);
        let (alloc_end, bytes_end) = alloc_counts();
        println!(
            "MEM_WALK viewport={viewport} weather={weather} overlay_off={} no_frame={} start={start} frames={frames} alloc_count_delta={} alloc_bytes_delta={} malloc_count_delta={} malloc_size_start={} malloc_size_end={} malloc_size_min={} malloc_size_max={} gc_threshold_transitions={gc_threshold_transitions}",
            std::env::var("G6_WEATHER_OVERLAY_OFF").is_ok(),
            std::env::var("G6_WEATHER_OVERLAY_NO_FRAME").is_ok(),
            alloc_end - alloc_start,
            bytes_end - bytes_start,
            count_end - count_start,
            size_start,
            size_end,
            size_min,
            size_max,
        );
        let _ = std::fs::remove_dir_all(data);
    }

    /// Production-entry indoor fast-path probe. The real campaign tape is
    /// replayed into the downstairs interior before a neutral-input window
    /// is measured. World diagnostics stay disabled, just as they do in a
    /// release launch, so this can compare a feature branch with a built
    /// baseline without exercising the opt-in outdoor renderer.
    #[test]
    #[ignore]
    fn indoor_fast_path() {
        let dist = PathBuf::from(std::env::var("G6_DIST").expect("G6_DIST"));
        let journey_path = PathBuf::from(std::env::var("G6_JOURNEY").expect("G6_JOURNEY"));
        let journey: Journey =
            serde_json::from_slice(&std::fs::read(journey_path).unwrap()).unwrap();
        let width: u32 = std::env::var("G6_BENCH_W").unwrap().parse().unwrap();
        let height: u32 = std::env::var("G6_BENCH_H").unwrap().parse().unwrap();
        let viewport = format!("{width}x{height}");
        let start: usize = std::env::var("G6_INDOOR_START")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1_200);
        let warmup: usize = std::env::var("G6_INDOOR_WARMUP")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(300);
        let frames: usize = std::env::var("G6_INDOOR_FRAMES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(4_000);
        let expected_map =
            std::env::var("G6_INDOOR_MAP").unwrap_or_else(|_| "spyder_downstairs".into());
        assert!(
            start < journey.masks.len(),
            "indoor start lies beyond the journey"
        );

        let bench_root = PathBuf::from(std::env::var("G6_BENCH_ROOT").expect("G6_BENCH_ROOT"));
        let data = bench_root.join(format!(
            "qjs-indoor-{}-{width}x{height}",
            std::process::id(),
        ));
        let maps = PathBuf::from(std::env::var("G6_MAPS").expect("G6_MAPS"));
        seed_maps(&maps, &data);
        let battle = PathBuf::from(std::env::var("G6_BATTLE").expect("G6_BATTLE"));
        seed_battle(&battle, &data);
        let animated = PathBuf::from(std::env::var("G6_ANIMATED").expect("G6_ANIMATED"));
        seed_animated(&animated, &data);
        let npc_src = PathBuf::from(std::env::var("G6_NPC_SRC").expect("G6_NPC_SRC"));
        seed_npc_src(&npc_src, &data);
        let terrain_stream =
            PathBuf::from(std::env::var("G6_TERRAIN_STREAM").expect("G6_TERRAIN_STREAM"));
        seed_terrain_stream(&terrain_stream, &data);
        seed_audio(&data);

        let (runtime, _stages) =
            boot_staged(args(&dist, "pocket-tuxemon", data, width, height)).unwrap();
        let (profile_frames, profile_marks, profile_capture) = frame_profile_config();
        let mut bench = Bench {
            rt: runtime,
            gc_mode: GcMode::from_env(),
            sample_structural: false,
            hash_every: 10,
            battle_buckets: false,
            handoff_buckets: false,
            profile_frames,
            profile_marks,
            profile_capture,
        };
        bench.install_frame_profiler();
        assert!(
            !bench.boolean("typeof globalThis.__pocketTuxemonWorldDiagnostics !== 'undefined'"),
            "indoor fast-path probe must not enable world diagnostics",
        );
        for index in 0..=start {
            let _sample = bench.frame(index, journey.masks[index], None, false);
        }
        assert_eq!(
            bench.state().0,
            expected_map,
            "tape did not reach the indoor fixture"
        );
        for offset in 0..warmup {
            let _sample = bench.frame(start + 1 + offset, 0, None, false);
        }

        let samples: Vec<Sample> = (0..frames)
            .map(|offset| bench.frame(start + 1 + warmup + offset, 0, None, false))
            .collect();
        assert!(
            samples
                .iter()
                .all(|sample| sample.map == expected_map && !sample.battle),
            "indoor fixture left the single-map world path",
        );
        report(&viewport, "indoor-fast-path", &samples);
        assert_frame_budget("indoor-fast-path", &samples, 50.0);
        println!(
            "INDOOR_FAST_PATH viewport={viewport} map={expected_map} replay_frames={} warmup_frames={warmup} measured_frames={frames} world_diagnostics=false",
            start + 1,
        );
    }

    fn timed_bool(bench: &Bench, source: &str) -> (bool, f64) {
        let started = Instant::now();
        let result = bench.boolean(source);
        (result, started.elapsed().as_secs_f64() * 1_000.0)
    }

    fn timed_unit(bench: &Bench, source: &str) -> f64 {
        let started = Instant::now();
        bench.unit(source);
        started.elapsed().as_secs_f64() * 1_000.0
    }

    #[test]
    #[ignore]
    fn map_first_visits() {
        let dist = PathBuf::from(std::env::var("G6_MAP_BENCH_DIST").expect("G6_MAP_BENCH_DIST"));
        let maps = PathBuf::from(std::env::var("G6_MAPS").expect("G6_MAPS"));
        let bench_root = PathBuf::from(std::env::var("G6_BENCH_ROOT").expect("G6_BENCH_ROOT"));
        let report = PathBuf::from(std::env::var("G6_MAP_REPORT").expect("G6_MAP_REPORT"));
        let data = bench_root.join(format!("qjs-map-data-{}", std::process::id()));
        seed_maps(&maps, &data);
        let runtime =
            Runtime::boot(args(&dist, "map-benchmark-entry", data.clone(), 480, 272)).unwrap();
        let (profile_frames, profile_marks, profile_capture) = frame_profile_config();
        let bench = Bench {
            rt: runtime,
            gc_mode: GcMode::from_env(),
            sample_structural: false,
            hash_every: 1,
            battle_buckets: false,
            handoff_buckets: false,
            profile_frames,
            profile_marks,
            profile_capture,
        };
        let metadata: Vec<MapMeta> = serde_json::from_str(
            &bench.string("JSON.stringify(globalThis.__rpgMapBenchmark.maps)"),
        )
        .expect("map benchmark metadata");
        assert_eq!(metadata.len(), 263, "benchmark must see every imported map");

        let mut samples = Vec::with_capacity(metadata.len());
        for meta in metadata {
            let id = serde_json::to_string(&meta.id).unwrap();
            bench.unit(&format!("globalThis.__rpgMapBenchmark.begin({id})"));
            let total_started = Instant::now();
            let (parsed, read_parse_ms) =
                timed_bool(&bench, &format!("globalThis.__rpgMapBenchmark.step({id})"));
            let (validated, validate_ms) =
                timed_bool(&bench, &format!("globalThis.__rpgMapBenchmark.step({id})"));
            let (world_compiled, world_compile_ms) =
                timed_bool(&bench, &format!("globalThis.__rpgMapBenchmark.step({id})"));
            let (compiled, passage_compile_ms) =
                timed_bool(&bench, &format!("globalThis.__rpgMapBenchmark.step({id})"));
            assert!(!parsed, "{} parse step must remain staged", meta.id);
            assert!(!validated, "{} validation step must remain staged", meta.id);
            assert!(
                !world_compiled,
                "{} world compilation must remain staged",
                meta.id
            );
            assert!(
                compiled,
                "{} passage compilation must complete preparation",
                meta.id
            );
            let commit_ms = timed_unit(
                &bench,
                &format!("globalThis.__rpgMapBenchmark.commit({id})"),
            );
            let total_ms = total_started.elapsed().as_secs_f64() * 1_000.0;
            let bytes = std::fs::metadata(maps.join(&meta.entry["maps/".len()..]))
                .expect("map entry metadata")
                .len();
            samples.push(MapSample {
                meta,
                bytes,
                read_parse_ms,
                validate_ms,
                world_compile_ms,
                passage_compile_ms,
                commit_ms,
                total_ms,
            });
        }

        let mut table = String::from(
            "map\twidth\theight\tbytes\tread_parse_ms\tvalidate_ms\tworld_compile_ms\tpassage_compile_ms\tcommit_ms\tworst_stage_ms\ttotal_ms\tlimit\n",
        );
        let mut stages = Vec::with_capacity(samples.len());
        let mut worst_non_exempt: Option<(&MapSample, f64)> = None;
        let mut worst_all: Option<(&MapSample, f64)> = None;
        for sample in &samples {
            let worst = sample
                .read_parse_ms
                .max(sample.validate_ms)
                .max(sample.world_compile_ms)
                .max(sample.passage_compile_ms)
                .max(sample.commit_ms);
            stages.push(worst);
            if worst_all.map_or(true, |(_, value)| worst > value) {
                worst_all = Some((sample, worst));
            }
            if sample.meta.id != "test_npcs"
                && worst_non_exempt.map_or(true, |(_, value)| worst > value)
            {
                worst_non_exempt = Some((sample, worst));
            }
            let limit = if sample.meta.id == "test_npcs" {
                "exempt"
            } else if worst <= 50.0 {
                "pass"
            } else {
                "FAIL"
            };
            writeln!(
                table,
                "{}\t{}\t{}\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}",
                sample.meta.id,
                sample.meta.width,
                sample.meta.height,
                sample.bytes,
                sample.read_parse_ms,
                sample.validate_ms,
                sample.world_compile_ms,
                sample.passage_compile_ms,
                sample.commit_ms,
                worst,
                sample.total_ms,
                limit,
            )
            .unwrap();
        }
        if let Some(parent) = report.parent() {
            std::fs::create_dir_all(parent).expect("create map report directory");
        }
        std::fs::write(&report, table).expect("write map first-visit report");

        stages.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let (worst_map, worst_ms) = worst_all.unwrap();
        let (worst_non_exempt_map, worst_non_exempt_ms) = worst_non_exempt.unwrap();
        println!(
            "MAPS n={} stage_p95={:.3}ms stage_max={:.3}ms worst={} non_exempt_max={:.3}ms non_exempt_worst={} report={}",
            samples.len(),
            percentile(&stages, 0.95),
            worst_ms,
            worst_map.meta.id,
            worst_non_exempt_ms,
            worst_non_exempt_map.meta.id,
            report.display(),
        );
        assert!(
            worst_non_exempt_ms <= 50.0,
            "map {} exceeded the 50 ms staged first-visit limit: {:.3} ms",
            worst_non_exempt_map.meta.id,
            worst_non_exempt_ms,
        );
        let _ = std::fs::remove_dir_all(data);
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorldStressDiagnostics {
        acknowledged: Option<usize>,
        #[serde(default)]
        maps: Vec<String>,
        #[serde(default)]
        links: HashMap<String, Vec<String>>,
        cache: Option<WorldStressCache>,
        stream: Option<WorldStressStreamBands>,
        animated: Option<WorldStressAnimatedBands>,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorldStressCache {
        driver: WorldStressDriver,
        visual_keep: Vec<String>,
        npc_keep: Vec<String>,
        assets: WorldStressAssets,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorldStressDriver {
        active: String,
        visible: Vec<String>,
        parsed_keep: Vec<String>,
        compiled_keep: Vec<String>,
        maps: usize,
        worlds: usize,
        tables: usize,
        staged: usize,
        pending: usize,
        preparing: usize,
        runtime: usize,
        repo_cached: usize,
        failures: serde_json::Value,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct WorldStressAssets {
        ground: WorldStressLazy,
        upper: WorldStressLazy,
        animated: WorldStressLazy,
        #[serde(rename = "npcSrc")]
        npc_src: WorldStressLazy,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct WorldStressLazy {
        resident: usize,
        loads: usize,
        evictions: usize,
        missing: usize,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct WorldStressStreamBands {
        ground: Option<WorldStressStream>,
        upper: Option<WorldStressStream>,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorldStressStream {
        map_id: String,
        #[serde(default)]
        visible_maps: Vec<String>,
        resident: usize,
        textures: usize,
        pooled: usize,
        created: usize,
        pending: usize,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct WorldStressAnimatedBands {
        below: Option<WorldStressAnimated>,
        above: Option<WorldStressAnimated>,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct WorldStressAnimated {
        mounted: usize,
        created: usize,
        pooled: usize,
    }

    #[derive(Clone, Debug, Default)]
    struct WorldStressPeak {
        maps: usize,
        worlds: usize,
        tables: usize,
        repo_cached: usize,
        ground_shards: usize,
        upper_shards: usize,
        animated_shards: usize,
        npc_refs: usize,
        stream_textures: usize,
        terrain_nodes: usize,
        animated_nodes: usize,
        native_nodes: usize,
        live_textures: usize,
        texture_slots: usize,
        heap_bytes: usize,
    }

    impl WorldStressPeak {
        fn observe(
            &mut self,
            diagnostic: &WorldStressDiagnostics,
            surface: &UiSurface,
            heap_bytes: usize,
        ) {
            let Some(cache) = &diagnostic.cache else {
                return;
            };
            self.maps = self.maps.max(cache.driver.maps);
            self.worlds = self.worlds.max(cache.driver.worlds);
            self.tables = self.tables.max(cache.driver.tables);
            self.repo_cached = self.repo_cached.max(cache.driver.repo_cached);
            self.ground_shards = self.ground_shards.max(cache.assets.ground.resident);
            self.upper_shards = self.upper_shards.max(cache.assets.upper.resident);
            self.animated_shards = self.animated_shards.max(cache.assets.animated.resident);
            self.npc_refs = self.npc_refs.max(cache.assets.npc_src.resident);
            if let Some(stream) = &diagnostic.stream {
                let ground = stream.ground.as_ref();
                let upper = stream.upper.as_ref();
                self.stream_textures = self.stream_textures.max(
                    ground.map_or(0, |value| value.textures)
                        + upper.map_or(0, |value| value.textures),
                );
                self.terrain_nodes = self.terrain_nodes.max(
                    ground.map_or(0, |value| value.created)
                        + upper.map_or(0, |value| value.created),
                );
            }
            if let Some(animated) = &diagnostic.animated {
                self.animated_nodes = self.animated_nodes.max(
                    animated.below.as_ref().map_or(0, |value| value.created)
                        + animated.above.as_ref().map_or(0, |value| value.created),
                );
            }
            let (nodes, live_textures, texture_slots) = surface_counts(surface);
            self.native_nodes = self.native_nodes.max(nodes);
            self.live_textures = self.live_textures.max(live_textures);
            self.texture_slots = self.texture_slots.max(texture_slots);
            self.heap_bytes = self.heap_bytes.max(heap_bytes);
        }
    }

    fn world_stress_diagnostics(bench: &Bench) -> WorldStressDiagnostics {
        serde_json::from_str(
            &bench.string("JSON.stringify(globalThis.__pocketTuxemonWorldDiagnostics)"),
        )
        .expect("world-cache diagnostics JSON")
    }

    fn surface_counts(surface: &UiSurface) -> (usize, usize, usize) {
        surface.with_ui(|ui| {
            let mut nodes = 0usize;
            let mut stack = vec![1i32];
            while let Some(id) = stack.pop() {
                if !ui.node_exists(id) {
                    continue;
                }
                nodes += 1;
                stack.extend_from_slice(ui.node_children(id));
            }
            let slots = ui.texture_slot_count();
            let live = (0..slots)
                .filter(|slot| ui.texture_at(*slot as u32).is_some())
                .count();
            (nodes, live, slots)
        })
    }

    fn force_qjs_gc(guest: &Guest) {
        guest.with(|ctx| unsafe {
            let runtime = pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            pocket_mod::qjs::qjs::JS_RunGC(runtime);
        });
    }

    fn world_stress_settled(diagnostic: &WorldStressDiagnostics, seq: usize, map_id: &str) -> bool {
        let Some(cache) = &diagnostic.cache else {
            return false;
        };
        let Some(stream) = &diagnostic.stream else {
            return false;
        };
        let (Some(ground), Some(upper)) = (&stream.ground, &stream.upper) else {
            return false;
        };
        diagnostic.acknowledged == Some(seq)
            && cache.driver.active == map_id
            && ground.map_id == map_id
            && upper.map_id == map_id
            && ground.visible_maps.iter().any(|id| id == map_id)
            && upper.visible_maps.iter().any(|id| id == map_id)
            && cache.visual_keep.iter().any(|id| id == map_id)
            && ground.pending == 0
            && upper.pending == 0
            && cache.driver.pending == 0
    }

    fn assert_world_stress_contract(diagnostic: &WorldStressDiagnostics, map_id: &str) {
        let cache = diagnostic
            .cache
            .as_ref()
            .expect("settled cache diagnostics");
        let stream = diagnostic
            .stream
            .as_ref()
            .expect("settled stream diagnostics");
        let ground = stream.ground.as_ref().expect("settled ground diagnostics");
        let upper = stream.upper.as_ref().expect("settled upper diagnostics");
        let animated = diagnostic
            .animated
            .as_ref()
            .expect("settled animated diagnostics");
        let driver = &cache.driver;

        assert_eq!(
            driver.active, map_id,
            "active map must follow the requested entry"
        );
        assert!(
            driver.visible.iter().any(|id| id == map_id),
            "active map must be visible"
        );
        assert!(
            driver.parsed_keep.iter().any(|id| id == map_id),
            "active map must be parsed"
        );
        assert!(
            driver.compiled_keep.iter().any(|id| id == map_id),
            "active map must be compiled"
        );
        assert!(
            driver
                .visible
                .iter()
                .all(|id| driver.parsed_keep.contains(id)),
            "visible maps must be retained in the parsed working set",
        );
        assert!(
            driver.maps <= driver.parsed_keep.len(),
            "parsed map cache exceeded its keep-set"
        );
        assert!(
            driver.repo_cached <= driver.parsed_keep.len(),
            "repository cache exceeded its keep-set"
        );
        assert!(
            driver.worlds <= driver.compiled_keep.len(),
            "compiled world cache exceeded its keep-set"
        );
        assert!(
            driver.tables <= driver.compiled_keep.len(),
            "passage cache exceeded its keep-set"
        );
        assert!(
            driver.runtime <= 1,
            "mutable passage cache must remain active-map-only"
        );
        assert_eq!(
            driver.pending, 0,
            "settled route still has pending prefetch work"
        );
        assert_eq!(
            driver.preparing, driver.staged,
            "all remaining preparations must be complete"
        );
        assert!(
            driver
                .failures
                .as_object()
                .is_some_and(|value| value.is_empty()),
            "world prefetch failed"
        );

        assert_eq!(
            ground.visible_maps, cache.visual_keep,
            "ground/provider visible set drift"
        );
        assert_eq!(
            upper.visible_maps, cache.visual_keep,
            "upper/provider visible set drift"
        );
        assert!(
            cache.assets.ground.resident <= cache.visual_keep.len(),
            "{map_id}: ground shards {} exceeded visual keep-set {:?}",
            cache.assets.ground.resident,
            cache.visual_keep
        );
        assert!(
            cache.assets.upper.resident <= cache.visual_keep.len(),
            "{map_id}: upper shards {} exceeded visual keep-set {:?}",
            cache.assets.upper.resident,
            cache.visual_keep
        );
        assert!(
            cache.assets.animated.resident <= cache.visual_keep.len(),
            "{map_id}: animated shards {} exceeded visual keep-set {:?}",
            cache.assets.animated.resident,
            cache.visual_keep
        );
        assert!(
            cache.assets.npc_src.resident <= cache.npc_keep.len(),
            "{map_id}: NPC refs {} exceeded active-map keep-set {:?}",
            cache.assets.npc_src.resident,
            cache.npc_keep
        );
        for (name, stats) in [
            ("ground", &cache.assets.ground),
            ("upper", &cache.assets.upper),
            ("npc", &cache.assets.npc_src),
        ] {
            assert_eq!(stats.missing, 0, "{name} provider reported missing entries");
            assert!(
                stats.loads >= stats.resident,
                "{name} provider load counter regressed"
            );
            assert!(
                stats.loads >= stats.evictions,
                "{name} provider eviction counter exceeded loads"
            );
        }
        // Most maps intentionally have no authored animation shard, so a
        // lookup miss is the provider's normal `tiles[id] ?? []` path.
        assert!(cache.assets.animated.loads >= cache.assets.animated.resident);
        assert!(cache.assets.animated.loads >= cache.assets.animated.evictions);
        for (name, stats) in [("ground", ground), ("upper", upper)] {
            assert_eq!(stats.pending, 0, "{name} terrain still pending");
            assert_eq!(
                stats.resident + stats.pooled,
                stats.created,
                "{name} terrain node pool leaked"
            );
            assert_eq!(
                stats.textures, stats.resident,
                "{name} terrain texture residency drifted"
            );
        }
        for (name, stats) in [
            (
                "below",
                animated
                    .below
                    .as_ref()
                    .expect("below animation diagnostics"),
            ),
            (
                "above",
                animated
                    .above
                    .as_ref()
                    .expect("above animation diagnostics"),
            ),
        ] {
            assert_eq!(
                stats.mounted + stats.pooled,
                stats.created,
                "{name} animation node pool leaked"
            );
        }
    }

    fn assert_peak_not_greater(label: &str, revisit: usize, first: usize) {
        assert!(
            revisit <= first,
            "revisit grew {label}: first-pass maximum {first}, second-pass maximum {revisit}",
        );
    }

    fn append_world_walk(
        map_id: &str,
        links: &HashMap<String, Vec<String>>,
        visited: &mut HashSet<String>,
        route: &mut Vec<(String, bool)>,
    ) {
        visited.insert(map_id.to_owned());
        let mut targets = links.get(map_id).cloned().unwrap_or_default();
        targets.sort();
        for target in targets {
            let can_return = links
                .get(&target)
                .is_some_and(|back| back.iter().any(|candidate| candidate == map_id));
            if visited.contains(&target) || !can_return {
                continue;
            }
            route.push((target.clone(), true));
            append_world_walk(&target, links, visited, route);
            route.push((map_id.to_owned(), true));
        }
    }

    /** A deterministic forest walk. `true` means the step follows a
     * bidirectional authored opening, so W3 must have staged its target. */
    fn world_stress_route(diagnostic: &WorldStressDiagnostics) -> Vec<(String, bool)> {
        let mut visited = HashSet::new();
        let mut route = Vec::new();
        for map_id in &diagnostic.maps {
            if visited.contains(map_id) {
                continue;
            }
            route.push((map_id.clone(), false));
            append_world_walk(map_id, &diagnostic.links, &mut visited, &mut route);
        }
        assert_eq!(
            visited.len(),
            diagnostic.maps.len(),
            "world walk omitted an outdoor map"
        );
        route
    }

    /// Production-entry, production-bundle traversal of every outdoor map.
    /// A diagnostics-only overlay asks the ordinary GameView to reconstruct
    /// each fresh map entry; rendering, provider reads, working-set policy,
    /// native texture allocation and GC all remain the shipped code paths.
    #[test]
    #[ignore]
    fn world_cache_stress() {
        assert!(
            std::env::var("G6_WORLD_CACHE_STRESS").is_ok(),
            "world_cache_stress requires G6_WORLD_CACHE_STRESS=1 before bundle eval",
        );
        let dist = PathBuf::from(std::env::var("G6_DIST").expect("G6_DIST"));
        let width: u32 = std::env::var("G6_BENCH_W").unwrap().parse().unwrap();
        let height: u32 = std::env::var("G6_BENCH_H").unwrap().parse().unwrap();
        let viewport = format!("{width}x{height}");
        let bench_root = PathBuf::from(std::env::var("G6_BENCH_ROOT").expect("G6_BENCH_ROOT"));
        let data = bench_root.join(format!("qjs-world-{}-{width}x{height}", std::process::id()));
        seed_maps(
            &PathBuf::from(std::env::var("G6_MAPS").expect("G6_MAPS")),
            &data,
        );
        seed_battle(
            &PathBuf::from(std::env::var("G6_BATTLE").expect("G6_BATTLE")),
            &data,
        );
        seed_animated(
            &PathBuf::from(std::env::var("G6_ANIMATED").expect("G6_ANIMATED")),
            &data,
        );
        seed_npc_src(
            &PathBuf::from(std::env::var("G6_NPC_SRC").expect("G6_NPC_SRC")),
            &data,
        );
        seed_terrain_stream(
            &PathBuf::from(std::env::var("G6_TERRAIN_STREAM").expect("G6_TERRAIN_STREAM")),
            &data,
        );
        seed_audio(&data);

        let (runtime, _) =
            boot_staged(args(&dist, "pocket-tuxemon", data.clone(), width, height)).unwrap();
        let (profile_frames, profile_marks, profile_capture) = frame_profile_config();
        let mut bench = Bench {
            rt: runtime,
            gc_mode: GcMode::from_env(),
            sample_structural: false,
            hash_every: 1,
            battle_buckets: false,
            handoff_buckets: false,
            profile_frames,
            profile_marks,
            profile_capture,
        };
        bench.install_frame_profiler();
        let initial_diagnostics = world_stress_diagnostics(&bench);
        let maps = initial_diagnostics.maps.clone();
        assert_eq!(
            maps.len(),
            67,
            "world-cache route must cover all 67 outdoor placements"
        );
        assert_eq!(
            maps.iter().collect::<HashSet<_>>().len(),
            67,
            "world-cache route contains duplicate maps"
        );
        let route = world_stress_route(&initial_diagnostics);
        let focus_map = std::env::var("G6_WORLD_FOCUS_MAP")
            .ok()
            .filter(|value| !value.is_empty());
        if let Some(target) = &focus_map {
            assert!(
                route.iter().any(|(map_id, _)| map_id == target),
                "G6_WORLD_FOCUS_MAP names a map outside the world-cache route: {target}"
            );
        }

        let mut timed_frames = Vec::new();
        let mut cross_map_frames = Vec::new();
        let mut direct_entry_frames = Vec::new();
        let mut world_all_frames = Vec::new();
        let mut prefetched_crossings = 0usize;
        let mut peaks = Vec::new();
        let mut heap_after_gc = Vec::new();
        let mut frame = 0usize;
        let mut seq = 0usize;
        let mut focus_complete = false;
        let passes = if focus_map.is_some() { 1 } else { 2 };
        'passes: for pass in 1..=passes {
            let mut peak = WorldStressPeak::default();
            let mut unique = HashSet::new();
            for (map_id, authored_edge) in &route {
                let collect = focus_map.as_ref().is_none_or(|target| target == map_id);
                unique.insert(map_id);
                let before = world_stress_diagnostics(&bench);
                let prefetched = before.cache.as_ref().is_some_and(|cache| {
                    cache.driver.active != *map_id
                        && cache
                            .driver
                            .compiled_keep
                            .iter()
                            .any(|candidate| candidate == map_id)
                        && cache.driver.pending == 0
                });
                if *authored_edge {
                    assert!(prefetched, "authored edge to {map_id} was not staged by W3");
                }
                if prefetched {
                    prefetched_crossings += 1;
                }
                seq += 1;
                let map_json = serde_json::to_string(map_id).unwrap();
                bench.unit(&format!(
                    "globalThis.__pocketTuxemonWorldDiagnostics.request={{seq:{seq},mapId:{map_json}}}"
                ));
                let mut settled_frames = 0usize;
                let mut settled = false;
                let mut entry_presented = false;
                let mut sampled_cross_frame = false;
                // Direct-neighbour preparation has at most four fixed stages
                // per map. Expensive stages may reserve one recovery frame;
                // 64 preserves a finite deadline without conflating bounded
                // staging latency with the per-frame 50 ms CPU gate below.
                for attempt in 0..64 {
                    let mut sample = bench.frame(frame, 0, None, true);
                    sample.temperature = if pass == 1 { "cold" } else { "hot" };
                    sample.class = if attempt == 0 {
                        format!("world-control-p{pass}")
                    } else if entry_presented && !sampled_cross_frame {
                        format!("world-cross-map-p{pass}")
                    } else {
                        format!("world-render-p{pass}-a{attempt}")
                    };
                    let sample_cpu = sample.js_cpu_ms + sample.core_cpu_ms + sample.draw_cpu_ms;
                    if collect && attempt == 0 {
                        // The diagnostics overlay performs startSession in
                        // this control frame. It is not a gameplay transfer;
                        // time the first ordinary production frame after the
                        // replacement as the cross-map rendering frame.
                        direct_entry_frames.push(sample.clone());
                    } else if collect {
                        timed_frames.push(sample.clone());
                        if entry_presented && !sampled_cross_frame {
                            cross_map_frames.push(sample.clone());
                            sampled_cross_frame = true;
                        }
                    }
                    if collect {
                        world_all_frames.push(sample.clone());
                    }
                    let diagnostic = world_stress_diagnostics(&bench);
                    if sample_cpu > 45.0 {
                        let cache = diagnostic
                            .cache
                            .as_ref()
                            .expect("slow-frame cache diagnostics");
                        let stream = diagnostic
                            .stream
                            .as_ref()
                            .expect("slow-frame stream diagnostics");
                        let ground_pending =
                            stream.ground.as_ref().map_or(0, |value| value.pending);
                        let upper_pending = stream.upper.as_ref().map_or(0, |value| value.pending);
                        println!(
                            "WORLD_SLOW viewport={viewport} pass={pass} map={map_id} attempt={attempt} prefetched={prefetched} cpu={sample_cpu:.3}ms js={:.3}ms core={:.3}ms draw={:.3}ms driver_pending={} driver_staged={} driver_preparing={} stream_pending={}/{}",
                            sample.js_cpu_ms,
                            sample.core_cpu_ms,
                            sample.draw_cpu_ms,
                            cache.driver.pending,
                            cache.driver.staged,
                            cache.driver.preparing,
                            ground_pending,
                            upper_pending,
                        );
                    }
                    peak.observe(&diagnostic, &bench.rt.surface, sample.heap_bytes);
                    frame += 1;
                    if diagnostic.acknowledged == Some(seq) {
                        entry_presented = true;
                    }
                    if world_stress_settled(&diagnostic, seq, map_id) {
                        assert_world_stress_contract(&diagnostic, map_id);
                        settled_frames += 1;
                        if settled_frames == 2 {
                            settled = true;
                            break;
                        }
                    } else {
                        settled_frames = 0;
                    }
                }
                assert!(
                    settled,
                    "map {map_id} did not settle within 64 production frames"
                );
                if focus_map.as_ref().is_some_and(|target| target == map_id) {
                    focus_complete = true;
                    break 'passes;
                }
            }
            force_qjs_gc(&bench.rt.guest);
            let (used, _, _) = qjs_memory(&bench.rt.guest);
            heap_after_gc.push(used.max(0) as usize);
            println!(
                "WORLD_PASS viewport={viewport} pass={pass} unique_maps={} route_entries={} maps={} worlds={} tables={} repo={} shards={}/{}/{} npc={} stream_textures={} terrain_nodes={} animated_nodes={} native_nodes={} live_textures={} texture_slots={} heap_peak={} heap_after_gc={}",
                unique.len(),
                route.len(),
                peak.maps,
                peak.worlds,
                peak.tables,
                peak.repo_cached,
                peak.ground_shards,
                peak.upper_shards,
                peak.animated_shards,
                peak.npc_refs,
                peak.stream_textures,
                peak.terrain_nodes,
                peak.animated_nodes,
                peak.native_nodes,
                peak.live_textures,
                peak.texture_slots,
                peak.heap_bytes,
                heap_after_gc.last().unwrap(),
            );
            peaks.push(peak);
        }

        if let Some(target) = focus_map {
            assert!(focus_complete, "focused world-cache map {target} was not visited");
            let first = world_all_frames.first().expect("focused world-cache first frame");
            let last = world_all_frames.last().expect("focused world-cache last frame");
            println!(
                "WORLD_FOCUS viewport={viewport} timeline=synthetic target={target} first_frame={} last_frame={} frames={}",
                first.frame,
                last.frame,
                world_all_frames.len(),
            );
            report(&viewport, "world-focus-cross-map", &cross_map_frames);
            report(&viewport, "world-focus-render", &timed_frames);
            report(
                &viewport,
                "world-focus-direct-control",
                &direct_entry_frames,
            );
            report_temperature(&viewport, "world-focus", &world_all_frames);
            report_slowest(&viewport, "world-focus", &world_all_frames);
            assert_frame_budget("world-focus", &world_all_frames, 45.0);
            let _ = std::fs::remove_dir_all(data);
            return;
        }

        report(&viewport, "world-stress-cross-map", &cross_map_frames);
        report(&viewport, "world-stress-render", &timed_frames);
        report(
            &viewport,
            "world-stress-direct-control",
            &direct_entry_frames,
        );
        report_temperature(&viewport, "world-cache", &world_all_frames);
        report_slowest(&viewport, "world-cache", &world_all_frames);
        assert_frame_budget("world-stress-cross-map", &cross_map_frames, 50.0);
        assert_frame_budget("world-stress-render", &timed_frames, 50.0);
        let first = &peaks[0];
        let revisit = &peaks[1];
        for (label, second, initial) in [
            ("parsed maps", revisit.maps, first.maps),
            ("compiled worlds", revisit.worlds, first.worlds),
            ("passage tables", revisit.tables, first.tables),
            ("repository entries", revisit.repo_cached, first.repo_cached),
            ("ground shards", revisit.ground_shards, first.ground_shards),
            ("upper shards", revisit.upper_shards, first.upper_shards),
            (
                "animated shards",
                revisit.animated_shards,
                first.animated_shards,
            ),
            ("NPC refs", revisit.npc_refs, first.npc_refs),
            (
                "stream textures",
                revisit.stream_textures,
                first.stream_textures,
            ),
            ("terrain nodes", revisit.terrain_nodes, first.terrain_nodes),
            (
                "animated nodes",
                revisit.animated_nodes,
                first.animated_nodes,
            ),
            ("native nodes", revisit.native_nodes, first.native_nodes),
            ("live textures", revisit.live_textures, first.live_textures),
            ("texture slots", revisit.texture_slots, first.texture_slots),
        ] {
            assert_peak_not_greater(label, second, initial);
        }
        let heap_slack = std::env::var("G6_WORLD_HEAP_SLACK")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(131_072usize);
        assert!(
            heap_after_gc[1] <= heap_after_gc[0] + heap_slack,
            "revisit QuickJS heap grew beyond plateau slack: first={} second={} slack={heap_slack}",
            heap_after_gc[0],
            heap_after_gc[1],
        );
        println!(
            "WORLD_PLATEAU viewport={viewport} unique_visits={} route_entries={} prefetched_crossings={} diagnostic_control_entries={} revisit_growth nodes={} textures={} ground={} upper={} animated={} npc={} heap={}B slack={}B",
            maps.len() * 2,
            route.len() * 2,
            prefetched_crossings,
            direct_entry_frames.len(),
            revisit.native_nodes.saturating_sub(first.native_nodes),
            revisit.texture_slots.saturating_sub(first.texture_slots),
            revisit.ground_shards.saturating_sub(first.ground_shards),
            revisit.upper_shards.saturating_sub(first.upper_shards),
            revisit
                .animated_shards
                .saturating_sub(first.animated_shards),
            revisit.npc_refs.saturating_sub(first.npc_refs),
            heap_after_gc[1] as i64 - heap_after_gc[0] as i64,
            heap_slack,
        );
        let _ = std::fs::remove_dir_all(data);
    }
}
