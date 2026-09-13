import { expect, test } from "bun:test"
import { sshHostname, sshName } from "./name"

test.each([
  ["brendan-box.exe.xyz", "brendan-box.exe.xyz"],
  ["ssh brendan-box.exe.xyz", "brendan-box.exe.xyz"],
  ["ssh anomaly@brendan-box.exe.xyz", "brendan-box.exe.xyz"],
  ['ssh -p 2222 -i "/keys/my key" -J jump@example.com anomaly@devbox', "devbox"],
  ["ssh -o 'ProxyCommand=ssh jump -W %h:%p' 'anomaly@devbox'", "devbox"],
  ["  ssh 'brendan-'box.exe.xyz  ", "brendan-box.exe.xyz"],
  ["ssh user@[2001:db8::1]", "[2001:db8::1]"],
  ["", ""],
])("uses the hostname from %s", (target, hostname) => {
  expect(sshHostname(target)).toBe(hostname)
  expect(sshName({ target, name: "" })).toBe(hostname)
})

test("preserves custom names and the original command", () => {
  const config = { name: "Development", target: "ssh -p 2222 anomaly@devbox" }
  expect(sshName(config)).toBe("Development")
  expect(config.target).toBe("ssh -p 2222 anomaly@devbox")
})
