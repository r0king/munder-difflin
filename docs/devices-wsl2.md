# A Windows machine as a device, through WSL2

Munder Difflin runs agents on Linux devices. A Windows machine joins as one by
running Ubuntu in WSL2 with Tailscale installed inside it. From the floor's
side it is an ordinary Linux device. Do these steps in order.

1. **Install WSL2 and Ubuntu.** In an administrator PowerShell, run
   `wsl --install -d Ubuntu`, reboot, then open Ubuntu and create your user.
   Use your laptop's username if you can, so you can skip step 8.

2. **Turn on systemd** so `tailscaled` and the agents' tmux keep running. In
   Ubuntu, run `sudoedit /etc/wsl.conf` and make sure it contains:

   ```ini
   [boot]
   systemd=true
   ```

   Then, in PowerShell, run `wsl --shutdown`. Open Ubuntu again and check that
   `systemctl is-system-running` prints `running` or `degraded`.

3. **Keep the WSL VM running when no window is open.** In Windows, create or
   edit `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   vmIdleTimeout=-1
   ```

   Then run `wsl --shutdown` again.

4. **Never sleep.** In Windows: Settings → System → Power → Screen and sleep →
   "When plugged in, put my device to sleep after" → Never. Or, in an
   administrator terminal: `powercfg /change standby-timeout-ac 0` and
   `powercfg /change hibernate-timeout-ac 0`.

5. **Start WSL after Windows restarts.** WSL starts only when something opens
   it. Open Ubuntu once after each reboot, or add a Task Scheduler task "At log
   on" that runs `wsl.exe -d Ubuntu --exec true`.

6. **Install Tailscale inside Ubuntu** (not only in Windows):
   `curl -fsSL https://tailscale.com/install.sh | sh`, then
   `sudo tailscale up --ssh`. In the Tailscale SSH policy, give this machine
   `"action": "accept"`, as for every device. Note its address:
   `tailscale ip -4`.

7. **Install the tools** in Ubuntu:
   `sudo apt update && sudo apt install -y nodejs tmux sshfs fuse3`. Check that
   `/dev/fuse` exists (`ls -l /dev/fuse`). Install Claude Code with
   `curl -fsSL https://claude.ai/install.sh | bash`, run `claude` and `/login`.
   Install any other engine your agents use there too.

8. **Use the same folder layout as the laptop.** If your Ubuntu user is not
   the laptop's, run `sudo ln -s /home/<your user> /home/royal`. If your repos
   live elsewhere, run
   `sudo mkdir -p /home/royal/Pro && sudo ln -s <your folder> /home/royal/Pro/Zensible`.
   Clone the repos your agents work in.

9. **Add it on the floor.** Open Settings → Devices → Add, with a name (for
   example `server`) and the Tailscale address from step 6. Then press Check.
   On WSL, Check adds "systemd on in WSL" and "/dev/fuse in WSL", and reminds
   you of steps 3 and 4, which it cannot see from inside WSL.
