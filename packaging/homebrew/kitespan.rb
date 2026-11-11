# kitespan's Homebrew formula, for the wannaFlyKa/homebrew-tap repository (Formula/kitespan.rb there). The release workflow
# fills in @VERSION@ and @SHA256@ for each release and prints the result for the owner (DESIGN-I1 4). It installs the
# release's source into libexec, its packages from the lockfile without the optional ones (so no bundled Claude Code
# binary) and without the development ones, builds the page there, and links bin/kitespan, which follows the link to
# find its folder.
class Kitespan < Formula
  desc "Browser UI for the Claude Code CLI on your own machine"
  homepage "https://github.com/wannaFlyKa/kitespan"
  url "https://github.com/wannaFlyKa/kitespan/releases/download/v@VERSION@/kitespan-@VERSION@.tar.gz"
  sha256 "@SHA256@"
  license "Apache-2.0"

  depends_on "bun"

  def install
    libexec.install Dir["*"]
    cd libexec do
      system "bun", "install", "--frozen-lockfile", "--omit=optional", "--production"
      system "bun", "run", "build"
    end
    bin.install_symlink libexec/"bin/kitespan"
  end

  test do
    ENV.prepend_path "PATH", Formula["bun"].opt_bin
    assert_match "kitespan #{version}", shell_output("#{bin}/kitespan --version")
    assert_match "Usage:", shell_output("#{bin}/kitespan --help")
  end
end
