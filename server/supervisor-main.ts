import { runSupervisor } from './supervisor'

// The agent terminal supervisor process: `supervisor <socket path>`. It is
// started detached, so it outlives the app that launched it.
const socketPath = process.argv[2]
if (!socketPath) { process.stderr.write('Usage: supervisor <socket path>\n'); process.exit(2) }
process.on('SIGHUP', () => {})
runSupervisor(socketPath).catch(error => { process.stderr.write(`${(error as Error).message}\n`); process.exit(1) })
