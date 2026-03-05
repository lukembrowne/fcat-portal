import Image from "next/image";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header with FCAT branding */}
      <header className="border-b bg-background">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
          <Image
            src="/logo-fcat.png"
            alt="FCAT"
            width={40}
            height={40}
            className="rounded"
          />
          <span className="text-lg font-semibold">Portal FCAT</span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-4 py-6">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>

      {/* Footer */}
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Fundación para la Conservación de los Andes Tropicales
      </footer>
    </div>
  );
}
