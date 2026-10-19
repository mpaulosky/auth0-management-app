// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     CleanService.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

namespace Architecture.Tests.Fixtures.Exposure;

// CA1515: PublicApiExposureRule inspects only publicly visible types, so these fixtures have to be public.
#pragma warning disable CA1515

public sealed class CleanService
{
	public string Name { get; } = "clean";

	public Task<IReadOnlyList<string>> GetNamesAsync() => throw new NotSupportedException();

	internal HttpClient InternalClient => throw new NotSupportedException();
}
#pragma warning restore CA1515
