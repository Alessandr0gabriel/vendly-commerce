# Vendly Commerce — portfólio técnico

Projeto independente de plataforma SaaS para gestão comercial, com módulos de pedidos, produtos, estoque, assinaturas e integrações. Esta é uma **cópia pública de demonstração/estudo**, separada da implantação de produção.

## Stack

- Front-end: HTML, CSS e JavaScript (com módulos ES).
- Back-end: Node.js, Express, Socket.IO.
- Dados/autenticação: Firebase/Firestore; suporte a emuladores locais.
- Testes: Node.js Test Runner e testes de integração via Firebase Emulator.

## Configuração segura para desenvolvimento

1. Instale Node.js compatível com as dependências e o Firebase CLI (`cd backend && npm ci`).
2. Use **somente** o Firebase Emulator com o projeto fictício `vendly-local`. Veja `backend/.env.local.example` para criar seu próprio `backend/.env.local` (não versionado).
3. Inicie os emuladores em um terminal: `cd backend && npm run emulator`.
4. Em outro terminal: `cd backend && npm run dev:local`. Configure o seed local com `LOCAL_ADMIN_PASSWORD` e `LOCAL_SUPERADMIN_PASSWORD` em seu arquivo privado, se necessário.
5. Sirva a pasta raiz do repositório com um servidor HTTP estático (por exemplo, a extensão Live Server na porta 5500). Abra `frontend/html/login.html`. **Não abra por `file://`.**

O arquivo `frontend/js/public-config.js` define o back-end de demonstração, com padrão `http://127.0.0.1:3000`. Altere **apenas para um back-end isolado de demonstração, sob seu controle**. Não inclua endereços, tokens ou credenciais da instância comercial de produção.

**Importante:** publicar arquivos estáticos no GitHub Pages não hospeda o servidor Node.js, Socket.IO nem os serviços Firebase. Sem um backend demonstrativo separado, as operações autenticadas não funcionarão publicamente. Os emuladores e suas credenciais de teste **não devem ser expostos na internet**.

## Testes

```bash
cd backend
npm test
```

Alguns testes de integração também exigem os emuladores.

## Segurança e publicação

- Nenhuma pasta `.git` antiga, `node_modules`, `.env` real, serviço Firebase JSON ou log foi incluído nesta entrega.
- Não publique a base de dados, usuários, IDs reais de clientes nem tokens do Mercado Pago.
- Assets externos do Cloudinary foram mantidos onde eram logos/imagens públicas, mas ainda pertencem ao ambiente original: considere substituir por arquivos locais antes de publicar.
- Antes de abrir um GitHub público, revise licenças de imagens, áudios e serviços externos.
- Esta limpeza de referências e arquivos **não equivale a uma auditoria de segurança completa**.

## Autoria

Projeto de portfólio e aprendizado prático. Registre contribuições de ferramentas e terceiros de maneira fiel quando aplicável.

## Observações da revisão de segurança

- Esta cópia **não é um serviço pronto para implantação pública**: configure emuladores apenas na própria máquina, sem expor as portas à internet.
- Dependências precisam ser verificadas com `npm audit --omit=dev` e `npm audit` em uma máquina com acesso ao registro npm.
- A validação com o backend de produção e o pentest externo não fazem parte da distribuição de portfólio.
- Antes de publicar, substitua assets vinculados ao Cloudinary comercial, se não quiser expor o identificador público de mídia.
- Não publique o histórico Git do projeto comercial nem credenciais de nenhuma natureza.
