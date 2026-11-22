// v1a-17: watch every open() by the core of a path ending with the text of `$NUNCHIRO_HOME/hold-suffix`. Each adds
// a byte to `opened`, then waits while `hold-open` exists; `open-released` tells the test a held call went on.
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void mark(const char *home, const char *name) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/%s", home, name);
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd >= 0) {
        (void)!write(fd, "x", 1);
        close(fd);
    }
}
static int held_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    const char *home = getenv("NUNCHIRO_HOME");
    if (home) {
        char name[PATH_MAX], suffix[PATH_MAX];
        snprintf(name, sizeof(name), "%s/hold-suffix", home);
        int fd = open(name, O_RDONLY);
        if (fd >= 0) {
            ssize_t n = read(fd, suffix, sizeof(suffix));
            close(fd);
            size_t len = strlen(path);
            if (n > 0 && (size_t)n <= len && memcmp(path + len - n, suffix, (size_t)n) == 0) {
                mark(home, "opened");
                snprintf(name, sizeof(name), "%s/hold-open", home);
                // Bounded so a broken test cannot leave the core parked forever.
                for (int i = 0; i < 3000 && access(name, F_OK) == 0; ++i) usleep(10000);
                mark(home, "open-released");
            }
        }
    }
    return open(path, flags, mode);
}
__attribute__((used, section("__DATA,__interpose"))) static const struct {
    const void *replacement;
    const void *original;
} mapping = {(const void *)held_open, (const void *)open};
