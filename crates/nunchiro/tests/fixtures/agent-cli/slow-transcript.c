// Synthetic macOS I/O barrier: delay only a marked home's JSONL realpath call; `read-released` (v1a-17) tells the
// test a held call went on.
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static char *slow_realpath(const char *path, char *resolved) {
    const char *home = getenv("NUNCHIRO_HOME");
    if (home && strstr(path, ".jsonl")) {
        char pause[PATH_MAX], entered[PATH_MAX], released[PATH_MAX];
        snprintf(pause, sizeof(pause), "%s/pause-read", home);
        snprintf(entered, sizeof(entered), "%s/read-entered", home);
        snprintf(released, sizeof(released), "%s/read-released", home);
        if (access(pause, F_OK) == 0) {
            int fd = open(entered, O_WRONLY | O_CREAT, 0600);
            if (fd >= 0) close(fd);
            for (int i = 0; i < 3000 && access(pause, F_OK) == 0; ++i) usleep(10000);
            fd = open(released, O_WRONLY | O_CREAT, 0600);
            if (fd >= 0) close(fd);
        }
    }
    return realpath(path, resolved);
}
__attribute__((used, section("__DATA,__interpose"))) static const struct {
    const void *replacement;
    const void *original;
} mapping = {(const void *)slow_realpath, (const void *)realpath};
