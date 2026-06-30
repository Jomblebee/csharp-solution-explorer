using MediatR;

namespace TaskFlow.Application.Projects.Commands.CreateProject;

public record CreateProjectCommand(string Name, string? Description) : IRequest<int>;
