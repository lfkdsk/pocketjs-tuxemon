// Included into a scratch copy of PocketJS's desktop host by
// bench-spectator-quickjs.sh. Evaluates the spectator battle bench bundle
// (tools/battle-oracle/spectator-bench-entry.ts) in a bare rquickjs Guest.
#[cfg(test)]
mod spectator_quickjs_bench {
    use super::*;
    use pocket_mod::qjs::Function;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn run() {
        let js_path =
            std::env::var("SPECTATOR_BENCH_JS").expect("SPECTATOR_BENCH_JS points at the built spectator-bench.js");
        let source = std::fs::read_to_string(&js_path).expect("read spectator-bench.js");

        let guest = Guest::new().expect("QuickJS guest");
        let start = Instant::now();
        guest
            .with(|ctx| -> anyhow::Result<()> {
                ctx.globals().set(
                    "__benchNow",
                    Function::new(ctx.clone(), move || start.elapsed().as_secs_f64() * 1_000.0)?,
                )?;
                Ok(())
            })
            .expect("bind __benchNow");

        guest.eval("spectator-bench", &source).expect("eval spectator-bench.js");

        let output: String = guest
            .with(|ctx| ctx.eval::<String, _>("globalThis.__out"))
            .expect("read globalThis.__out");
        println!("{output}");
    }
}
