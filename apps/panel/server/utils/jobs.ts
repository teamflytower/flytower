import { createLoaders } from '@flytower/providers'
import { JobRunner } from '../jobs/runner'

let loaders: ReturnType<typeof createLoaders> | undefined
let runner: JobRunner | undefined

/** The trusted loader providers, with their caches shared across requests. */
export function useLoaders() {
  loaders ??= createLoaders(fetch)
  return loaders
}

/** The one job runner for this process. */
export function useJobs(): JobRunner {
  runner ??= new JobRunner({
    db: useDb(),
    agent,
    loaders: useLoaders(),
    fetch,
    routing: {
      reservedPorts: () => useRouting().reservedPorts(),
      serverChanged: (name) => useRouting().serverChanged(name),
    },
  })
  return runner
}
