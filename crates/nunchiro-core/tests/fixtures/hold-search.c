// Park the core on one file while the test keeps `$NUNCHIRO_HOME/hold-search`, so a search is provably in
// flight; `search-held` tells the test it got there.
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static const char HELD[] = "/held-search.txt";
static int held_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    const char *home = getenv("NUNCHIRO_HOME");
    size_t n = strlen(path), k = sizeof(HELD) - 1;
    if (home && n >= k && strcmp(path + n - k, HELD) == 0) {
        char hold[PATH_MAX], held[PATH_MAX];
        snprintf(hold, sizeof(hold), "%s/hold-search", home);
        snprintf(held, sizeof(held), "%s/search-held", home);
        if (access(hold, F_OK) == 0) {
            int fd = open(held, O_WRONLY | O_CREAT, 0600);
            if (fd >= 0) close(fd);
            // Bounded so a broken test cannot leave the core parked forever.
            for (int i = 0; i < 6000 && access(hold, F_OK) == 0; ++i) usleep(10000);
        }
    }
    return open(path, flags, mode);
}
__attribute__((used, section("__DATA,__interpose"))) static const struct {
    const void *replacement;
    const void *original;
} mapping = {(const void *)held_open, (const void *)open};
