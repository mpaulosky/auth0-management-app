// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     SearchUsersQuery.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.Components.Features.Users;

/// <summary>
///   A request for one page of the Tenant's Users, as the Admin typed it.
/// </summary>
/// <param name="Query">The raw search box text, or <see langword="null" /> to list every User.</param>
/// <param name="Page">The 1-based page number.</param>
public sealed record SearchUsersQuery(string? Query, int Page);
