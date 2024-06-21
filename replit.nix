{pkgs}: {
  	deps = [
     pkgs.openssl.out
      pkgs.openssl];
	env = {
	  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.openssl_1_1.out ];
	};
}
