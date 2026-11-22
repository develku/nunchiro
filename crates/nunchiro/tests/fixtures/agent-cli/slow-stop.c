// Hold the old core's lifetime lock after its socket disappears.
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int slow_unlink(const char *path) {
    int result = unlink(path);
    const char *home = getenv("NUNCHIRO_HOME");
    if (result == 0 && home && strstr(path, "/core.sock")) {
        char pause[PATH_MAX], entered[PATH_MAX];
        snprintf(pause, sizeof(pause), "%s/pause-stop", home);
        snprintf(entered, sizeof(entered), "%s/stop-entered", home);
        if (access(pause, F_OK) == 0) {
            int fd = open(entered, O_WRONLY | O_CREAT, 0600);
            if (fd >= 0) close(fd);
            for (int i = 0; i < 300 && access(pause, F_OK) == 0; ++i) usleep(10000);
        }
    }
    return result;
}
__attribute__((used, section("__DATA,__interpose"))) static const struct {
    const void *replacement;
    const void *original;
} mapping = {(const void *)slow_unlink, (const void *)unlink};
